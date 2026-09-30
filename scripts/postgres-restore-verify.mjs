#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  archiveTables, assertIsolatedRestoreTarget, databaseConnection, databaseIdentity, parseArguments,
  requireConfirmation, run, sha256File, sqlIdentifier,
} from './lib/postgres-operations.mjs';

function usage() {
  console.log(`Usage:
  node scripts/postgres-restore-verify.mjs --inspect-target [--target-env RESTORE_VERIFY_DATABASE_URL]
  node scripts/postgres-restore-verify.mjs --archive /secure/path/courtly.dump \\
    --expect-target-fingerprint SHA256 --confirm-restore courtly_restore_verify_NAME \\
    --evidence /secure/path/restore-evidence.json [--target-env RESTORE_VERIFY_DATABASE_URL]

The target must already exist, be empty, use a courtly_restore_verify_ name, and run on loopback.`);
}

function query(connection, sql) {
  return run('psql', ['--no-psqlrc', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    environment: { ...connection.environment, PGAPPNAME: 'courtly_restore_verification' },
  });
}

try {
  process.umask(0o077);
  const args = parseArguments(process.argv.slice(2), {
    'inspect-target': 'boolean', archive: 'value', 'target-env': 'value',
    'expect-target-fingerprint': 'value', 'confirm-restore': 'value', evidence: 'value', help: 'boolean',
  });
  if (args.help) { usage(); process.exit(0); }
  const targetEnvironmentName = args['target-env'] || 'RESTORE_VERIFY_DATABASE_URL';
  if (!/^[A-Z][A-Z0-9_]*$/.test(targetEnvironmentName)) throw new Error('Target environment variable name is invalid');
  const rawUrl = process.env[targetEnvironmentName];
  if (!rawUrl) throw new Error(`${targetEnvironmentName} is required`);
  const connection = databaseConnection(rawUrl);
  assertIsolatedRestoreTarget(connection);
  const initialIdentity = databaseIdentity(connection);
  console.log(JSON.stringify({ mode: args['inspect-target'] ? 'inspect-target' : 'restore-verify', target: initialIdentity }, null, 2));
  if (args['inspect-target']) process.exit(0);

  if (!args.archive || !args.evidence) throw new Error('--archive and --evidence are required');
  requireConfirmation(initialIdentity.fingerprint, args['expect-target-fingerprint'], 'Target fingerprint');
  requireConfirmation(connection.database, args['confirm-restore'], 'Target database name');
  if (Number(initialIdentity.publicTableCount) !== 0) {
    throw new Error(`Restore target is not empty (${initialIdentity.publicTableCount} public tables found)`);
  }

  const archive = resolve(args.archive);
  const evidencePath = resolve(args.evidence);
  if (existsSync(evidencePath)) throw new Error(`Refusing to overwrite existing evidence: ${evidencePath}`);
  const archiveSha256 = sha256File(archive);
  let backupMetadata;
  try {
    backupMetadata = JSON.parse(readFileSync(`${archive}.metadata.json`, 'utf8'));
    if (backupMetadata.sha256 !== archiveSha256) throw new Error('Archive checksum does not match backup metadata');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Backup metadata is required at ${archive}.metadata.json`);
    }
    throw error;
  }

  const toc = run('pg_restore', ['--list', archive]);
  const expectedTables = archiveTables(toc);
  if (expectedTables.length === 0) throw new Error('Archive contains no public tables');
  const startedAt = new Date();
  const startedMonotonic = process.hrtime.bigint();
  run('pg_restore', [
    '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', connection.database, archive,
  ], { environment: { ...connection.environment, PGAPPNAME: 'courtly_restore_verification' }, inherit: true });

  const restoredTables = JSON.parse(query(connection, `
    SELECT COALESCE(json_agg(tablename ORDER BY tablename), '[]'::json)::text
    FROM pg_tables WHERE schemaname = 'public';
  `));
  const missingTables = expectedTables.filter(table => !restoredTables.includes(table));
  const unexpectedTables = restoredTables.filter(table => !expectedTables.includes(table));
  if (missingTables.length || unexpectedTables.length) {
    throw new Error(`Restored table manifest differs (missing: ${missingTables.join(', ') || 'none'}; unexpected: ${unexpectedTables.join(', ') || 'none'})`);
  }

  const countSql = expectedTables.map(table =>
    `SELECT '${table.replaceAll("'", "''")}' AS table_name, count(*)::text AS row_count FROM public.${sqlIdentifier(table)}`,
  ).join(' UNION ALL ');
  const rowCounts = JSON.parse(query(connection, `
    SELECT json_object_agg(table_name, row_count ORDER BY table_name)::text FROM (${countSql}) counts;
  `));
  const integrity = JSON.parse(query(connection, `
    SELECT json_build_object(
      'invalidConstraints', (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND NOT c.convalidated),
      'failedMigrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
      'appliedMigrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
      'publicTables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')
    )::text;
  `));
  if (Number(integrity.invalidConstraints) !== 0 || Number(integrity.failedMigrations) !== 0) {
    throw new Error(`Database integrity check failed: ${JSON.stringify(integrity)}`);
  }

  const backendDirectory = fileURLToPath(new URL('../backend/', import.meta.url));
  const migrationStatusOutput = run('npx', ['--no-install', 'prisma', 'migrate', 'status'], {
    cwd: backendDirectory, environment: { ...connection.environment, DATABASE_URL: rawUrl },
  });
  if (!migrationStatusOutput.includes('Database schema is up to date')) {
    throw new Error('Prisma did not report the restored schema as up to date');
  }
  const schemaHealthRaw = run('npx', ['--no-install', 'tsx', '--eval', `
    import { PrismaClient } from '@prisma/client';
    import { inspectSchema } from './src/schema-health.ts';
    const client = new PrismaClient();
    inspectSchema(client)
      .then(result => console.log(JSON.stringify(result)))
      .finally(() => client.$disconnect());
  `], { cwd: backendDirectory, environment: { ...connection.environment, DATABASE_URL: rawUrl } });
  const schemaHealth = JSON.parse(schemaHealthRaw.split('\n').at(-1));
  if (!schemaHealth.ready) throw new Error(`Courtly schema health check failed: ${schemaHealth.missing.join(', ')}`);

  const completedAt = new Date();
  const durationSeconds = Number(process.hrtime.bigint() - startedMonotonic) / 1e9;
  const evidence = {
    formatVersion: 1, exerciseKind: 'isolated-restore-verification', startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(), durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    archive: { filename: archive.split('/').at(-1), sha256: archiveSha256, createdAt: backupMetadata.createdAt, source: backupMetadata.source },
    target: databaseIdentity(connection), tableManifest: { expected: expectedTables.length, restored: restoredTables.length },
    rowCounts, integrity, schemaHealth, migrationStatus: 'up-to-date',
    result: 'PASS', cleanup: 'Target retained for operator inspection; remove it explicitly after evidence review.',
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: true, evidence: evidencePath, durationSeconds: evidence.durationSeconds, tableCount: restoredTables.length }, null, 2));
} catch (error) {
  console.error(`Restore verification aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
