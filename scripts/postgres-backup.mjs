#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  archiveTables, databaseConnection, databaseIdentity, parseArguments, requireConfirmation, run, sha256File,
} from './lib/postgres-operations.mjs';

function usage() {
  console.log(`Usage:
  node scripts/postgres-backup.mjs --inspect [--source-env DATABASE_URL]
  node scripts/postgres-backup.mjs --output /secure/path/courtly.dump \\
    --expect-source-fingerprint SHA256 --confirm-backup --confirm-encrypted-storage \\
    [--source-env DATABASE_URL]

The script reads the URL from an environment variable so credentials do not appear in the process arguments.`);
}

try {
  process.umask(0o077);
  const args = parseArguments(process.argv.slice(2), {
    inspect: 'boolean', output: 'value', 'source-env': 'value',
    'expect-source-fingerprint': 'value', 'confirm-backup': 'boolean',
    'confirm-encrypted-storage': 'boolean', help: 'boolean',
  });
  if (args.help) { usage(); process.exit(0); }
  const sourceEnvironmentName = args['source-env'] || 'DATABASE_URL';
  if (!/^[A-Z][A-Z0-9_]*$/.test(sourceEnvironmentName)) throw new Error('Source environment variable name is invalid');
  const rawUrl = process.env[sourceEnvironmentName];
  if (!rawUrl) throw new Error(`${sourceEnvironmentName} is required`);
  const connection = databaseConnection(rawUrl);
  const identity = databaseIdentity(connection);

  console.log(JSON.stringify({ mode: args.inspect ? 'inspect' : 'backup', source: identity }, null, 2));
  if (args.inspect) process.exit(0);
  if (!args.output) throw new Error('--output is required');
  if (!args['confirm-backup']) throw new Error('--confirm-backup is required after inspection');
  if (!args['confirm-encrypted-storage']) {
    throw new Error('--confirm-encrypted-storage is required because the archive contains production data');
  }
  requireConfirmation(identity.fingerprint, args['expect-source-fingerprint'], 'Source fingerprint');

  const output = resolve(args.output);
  const temporary = `${output}.partial-${process.pid}`;
  const metadataPath = `${output}.metadata.json`;
  const checksumPath = `${output}.sha256`;
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  for (const path of [output, metadataPath, checksumPath]) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite existing file: ${path}`);
  }

  try {
    run('pg_dump', [
      '--format=custom', '--compress=9', '--no-owner', '--no-privileges',
      '--serializable-deferrable', '--lock-wait-timeout=10000', '--file', temporary,
    ], { environment: { ...connection.environment, PGAPPNAME: 'courtly_backup' }, inherit: true });
    const toc = run('pg_restore', ['--list', temporary]);
    const tables = archiveTables(toc);
    if (tables.length === 0) throw new Error('Archive contains no public tables');
    const sha256 = sha256File(temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    writeFileSync(checksumPath, `${sha256}  ${output.split('/').at(-1)}\n`, { mode: 0o600 });
    writeFileSync(metadataPath, `${JSON.stringify({
      formatVersion: 1, createdAt: new Date().toISOString(), archive: output.split('/').at(-1), sha256,
      source: identity, publicTables: tables, publicTableCount: tables.length,
      pgDumpVersion: run('pg_dump', ['--version']), pgRestoreVersion: run('pg_restore', ['--version']),
    }, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, archive: output, metadata: metadataPath, checksum: checksumPath, sha256, publicTableCount: tables.length }, null, 2));
  } finally {
    rmSync(temporary, { force: true });
  }
} catch (error) {
  console.error(`Backup aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
