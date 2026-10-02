import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTransactionConflict, retryingTransaction, serializableTransaction } from '../src/db.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const conflict = (code = 'P2034', meta: Record<string, unknown> = {}) =>
  new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', {
    code, clientVersion: Prisma.prismaVersion.client, meta,
  });

describe('transaction conflict retries', () => {
  it('recognises serialization and deadlock aborts only', () => {
    expect(isTransactionConflict(conflict())).toBe(true);
    expect(isTransactionConflict(conflict('P2010', { code: '40001', message: 'could not serialize access' }))).toBe(true);
    expect(isTransactionConflict(conflict('P2010', { code: '40P01', message: 'deadlock detected' }))).toBe(true);
    expect(isTransactionConflict(conflict('P2002'))).toBe(false);
    expect(isTransactionConflict(conflict('P2010', { code: '23505' }))).toBe(false);
    expect(isTransactionConflict(new Error('P2034'))).toBe(false);
  });

  it('runs a conflicted transaction again and returns the committed attempt', async () => {
    let attempts = 0;
    const isolation: string[] = [];
    const result = await serializableTransaction(async tx => {
      attempts += 1;
      const [row] = await tx.$queryRaw<{ level: string }[]>`SELECT current_setting('transaction_isolation') AS level`;
      isolation.push(row.level);
      if (attempts < 3) throw conflict();
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(isolation).toEqual(['serializable', 'serializable', 'serializable']);
  });

  it('does not retry ordinary failures and gives up on a persistent conflict', async () => {
    let attempts = 0;
    await expect(retryingTransaction(async () => {
      attempts += 1;
      throw conflict('P2002');
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(retryingTransaction(async () => {
      attempts += 1;
      throw conflict();
    })).rejects.toMatchObject({ code: 'P2034' });
    expect(attempts).toBe(8);
  });
});
