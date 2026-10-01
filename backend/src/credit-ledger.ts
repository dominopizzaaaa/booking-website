import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export type CreditEventKind =
  | 'BOOKED' | 'RESTORED' | 'RENTAL_RESERVED' | 'RENTAL_RESTORED' | 'ADJUSTED' | 'USED';

export type CreditContext = {
  kind?: CreditEventKind;
  bookingId?: string | null;
  participantId?: string | null;
  reservationId?: string | null;
  actorUserId?: string | null;
  note?: string;
};

/**
 * The LessonPackage trigger records every credit change into
 * PackageCreditEvent, whichever code path made it. This labels the next
 * change(s) in the current transaction so the ledger can say *why* a balance
 * moved. The setting is transaction-local and is cleared after `run`, so a
 * later, unrelated package write in the same transaction is never mislabelled.
 */
export async function withCreditContext<T>(tx: Tx, context: CreditContext, run: () => Promise<T>): Promise<T> {
  const payload = JSON.stringify({
    ...context,
    ...(context.note !== undefined ? { note: context.note.slice(0, 300) } : {}),
  });
  await tx.$executeRaw`SELECT set_config('courtly.credit_context', ${payload}, true)`;
  try {
    return await run();
  } finally {
    await tx.$executeRaw`SELECT set_config('courtly.credit_context', '', true)`;
  }
}
