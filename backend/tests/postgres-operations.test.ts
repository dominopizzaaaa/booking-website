import { describe, expect, it } from 'vitest';
import {
  archiveTables, assertIsolatedRestoreTarget, databaseConnection, parseArguments, requireConfirmation, sqlIdentifier,
} from '../../scripts/lib/postgres-operations.mjs';

describe('PostgreSQL recovery safety helpers', () => {
  it('parses connection metadata without retaining the URL', () => {
    const connection = databaseConnection('postgresql://courtly:secret@127.0.0.1:55432/courtly_restore_verify_test?schema=public&sslmode=require');
    expect(connection).toMatchObject({ database: 'courtly_restore_verify_test', host: '127.0.0.1', port: 55432, user: 'courtly' });
    expect(connection.environment).toMatchObject({ PGDATABASE: 'courtly_restore_verify_test', PGPASSWORD: 'secret', PGSSLMODE: 'require' });
  });

  it('allows only deliberately named loopback restore targets', () => {
    expect(() => assertIsolatedRestoreTarget(databaseConnection('postgresql://u:p@127.0.0.1/courtly_restore_verify_test'))).not.toThrow();
    expect(() => assertIsolatedRestoreTarget(databaseConnection('postgresql://u:p@db.example.com/courtly_restore_verify_test'))).toThrow(/loopback/);
    expect(() => assertIsolatedRestoreTarget(databaseConnection('postgresql://u:p@localhost/courtly'))).toThrow(/must start/);
  });

  it('requires exact confirmations and rejects unknown arguments', () => {
    expect(() => requireConfirmation('expected', 'different', 'Target')).toThrow(/did not match/);
    expect(() => parseArguments(['--surprise'], { inspect: 'boolean' })).toThrow(/Unknown argument/);
  });

  it('extracts a sorted archive table manifest and quotes SQL identifiers', () => {
    const toc = '123; 0 1 TABLE public User postgres\n124; 0 2 TABLE public Booking postgres\n';
    expect(archiveTables(toc)).toEqual(['Booking', 'User']);
    expect(sqlIdentifier('odd"table')).toBe('"odd""table"');
  });
});
