import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const IGNORED_CONNECTION_PARAMETERS = new Set([
  'schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'connect_timeout',
]);
const LIBPQ_CONNECTION_PARAMETERS = new Map([
  ['sslmode', 'PGSSLMODE'], ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY'],
  ['sslrootcert', 'PGSSLROOTCERT'], ['sslcrl', 'PGSSLCRL'], ['sslcompression', 'PGSSLCOMPRESSION'],
  ['application_name', 'PGAPPNAME'], ['options', 'PGOPTIONS'], ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
]);

export function parseArguments(argv, specification) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !(token.slice(2) in specification)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const name = token.slice(2);
    if (specification[name] === 'boolean') {
      parsed[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

export function databaseConnection(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('The database URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The database URL must use postgres:// or postgresql://');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Error('The database URL must identify a host and database');

  const environment = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username || ''),
    PGPASSWORD: decodeURIComponent(url.password || ''),
    PGAPPNAME: 'courtly_database_operation',
  };
  for (const [key, value] of url.searchParams) {
    if (IGNORED_CONNECTION_PARAMETERS.has(key)) continue;
    const environmentName = LIBPQ_CONNECTION_PARAMETERS.get(key);
    if (environmentName) environment[environmentName] = value;
  }
  return {
    database,
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || ''),
    environment,
  };
}

export function assertIsolatedRestoreTarget(connection) {
  if (!LOOPBACK_HOSTS.has(connection.host.toLowerCase())) {
    throw new Error('Restore verification is restricted to a loopback PostgreSQL server');
  }
  if (!/^courtly_restore_verify_[a-z0-9_]+$/.test(connection.database)) {
    throw new Error('Restore target database must start with courtly_restore_verify_');
  }
  if (['postgres', 'template0', 'template1', 'courtly', 'courtly_test'].includes(connection.database)) {
    throw new Error('Restore verification cannot use an application, test, or PostgreSQL maintenance database');
  }
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.inherit ? '' : `: ${(result.stderr || result.stdout || '').trim()}`;
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return options.inherit ? '' : result.stdout.trim();
}

export function databaseIdentity(connection) {
  const sql = `
    SELECT json_build_object(
      'database', current_database(),
      'databaseOid', (SELECT oid::text FROM pg_database WHERE datname = current_database()),
      'user', current_user,
      'serverAddress', COALESCE(inet_server_addr()::text, 'local-socket'),
      'serverPort', inet_server_port(),
      'serverVersionNumber', current_setting('server_version_num'),
      'inRecovery', pg_is_in_recovery(),
      'publicTableCount', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
      'databaseBytes', pg_database_size(current_database())
    )::text;
  `;
  const output = run('psql', ['--no-psqlrc', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    environment: { ...connection.environment, PGAPPNAME: 'courtly_database_identity' },
  });
  const identity = JSON.parse(output);
  const material = [
    connection.host.toLowerCase(), String(connection.port), identity.database, identity.databaseOid,
    identity.user, identity.serverAddress, String(identity.serverPort), identity.serverVersionNumber,
  ].join('\n');
  return {
    ...identity,
    connectionHost: connection.host,
    connectionPort: connection.port,
    fingerprint: createHash('sha256').update(material).digest('hex'),
  };
}

export function requireConfirmation(actual, expected, description) {
  if (!expected || expected !== actual) {
    throw new Error(`${description} confirmation did not match; inspect again and copy the exact value`);
  }
}

export function sha256File(path) {
  const output = run('shasum', ['-a', '256', path]);
  const [digest] = output.split(/\s+/);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Could not calculate a SHA-256 archive digest');
  return digest;
}

export function archiveTables(toc) {
  const tables = new Set();
  for (const line of toc.split('\n')) {
    const match = line.match(/;?\s+\d+\s+\d+\s+TABLE public (\S+) /);
    if (match) tables.add(match[1]);
  }
  return [...tables].sort();
}

export function sqlIdentifier(value) {
  return `\"${value.replaceAll('\"', '\"\"')}\"`;
}
