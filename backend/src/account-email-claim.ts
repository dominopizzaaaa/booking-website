import { Prisma } from '@prisma/client';

type EmailClaimTransaction = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | '$queryRaw' | 'childAccountHandover' | 'outboundDelivery'
>;

type EmailClaimOptions = {
  now?: Date;
  excludeHandoverId?: string;
};

export function normalizedAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * Serializes every operation that can claim a login email. Expired handover
 * reservations are made terminal while the lock is held so a registration or
 * another handover can safely reuse the address.
 */
export async function lockAccountEmailClaim(
  tx: EmailClaimTransaction,
  email: string,
  options: EmailClaimOptions = {},
) {
  const normalizedEmail = normalizedAccountEmail(email);
  const now = options.now ?? new Date();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:account-email-claim:${normalizedEmail}`}, 0))`;
  await tx.$queryRaw`SELECT id FROM "ChildAccountHandover"
    WHERE "destinationEmail" = ${normalizedEmail} AND "status" = 'PENDING'
    FOR UPDATE`;

  const reservations = await tx.childAccountHandover.findMany({
    where: {
      destinationEmail: normalizedEmail,
      status: 'PENDING',
      ...(options.excludeHandoverId ? { id: { not: options.excludeHandoverId } } : {}),
    },
    select: { id: true, childUserId: true, expiresAt: true },
    orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
  });
  const expired = reservations.filter(reservation => reservation.expiresAt <= now);
  if (expired.length) {
    const expiredIds = expired.map(reservation => reservation.id);
    await tx.childAccountHandover.updateMany({
      where: { id: { in: expiredIds }, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    await tx.outboundDelivery.updateMany({
      where: {
        channel: 'EMAIL',
        dedupeKey: { in: expiredIds.map(id => `family-handover:${id}:security-claim`) },
        status: { in: ['QUEUED', 'SENDING'] },
      },
      data: {
        status: 'SUPPRESSED',
        leaseToken: null,
        leasedUntil: null,
        lastErrorCode: 'HANDOVER_EXPIRED',
        lastErrorAt: now,
      },
    });
  }

  return {
    normalizedEmail,
    expiredHandoverIds: expired.map(reservation => reservation.id),
    pendingHandover: reservations.find(reservation => reservation.expiresAt > now) ?? null,
  };
}
