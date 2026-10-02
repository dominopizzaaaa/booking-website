import './config.js';
import { Prisma, PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();

type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

// Serializable aborts cluster when several sign-ups or roster edits land at
// once; eight jittered attempts (at most ~3s of waiting) clear real bursts.
const TRANSACTION_ATTEMPTS = 8;

/**
 * PostgreSQL aborted the whole transaction because of a serialization
 * conflict or a deadlock. Nothing it wrote survived, so it can run again.
 * Serializable transactions also raise this for unrelated tenants whose
 * reads merely shared an index page, so it is not evidence of a real race.
 */
export function isTransactionConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  return /40001|40P01|could not serialize access|deadlock detected/.test(JSON.stringify(error.meta ?? {}));
}

/**
 * Run a transaction, retrying conflict aborts with jittered backoff. The
 * callback must only touch the database (outbox rows included): it may run
 * several times, and only the final committed attempt is observable.
 */
export async function retryingTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, options);
    } catch (error) {
      if (!isTransactionConflict(error) || attempt >= TRANSACTION_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 15 * 2 ** Math.min(attempt, 6)));
    }
  }
}

/** A Serializable transaction that survives the conflict aborts Serializable implies. */
export function serializableTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: Omit<TransactionOptions, 'isolationLevel'> = {},
) {
  return retryingTransaction(operation, { ...options, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
