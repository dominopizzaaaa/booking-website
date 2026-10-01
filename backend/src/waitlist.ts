import { Router } from 'express';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// Implemented by the waitlist workstream. See docs/TRAINING_COMPANION.md.
export const waitlistAccountRouter = Router();
export const waitlistWorkspaceRouter = Router();

/** Offer freed places on a group Class to the next waiting students. Caller holds the instructor lock. */
export async function offerWaitlistPlaces(_tx: Tx, _bookingId: string): Promise<void> {}

/** Close every live entry for a booking that can no longer take students. */
export async function closeWaitlistForBooking(_tx: Tx, _bookingId: string, _reason: string): Promise<void> {}

export function startWaitlistWorker(): () => void {
  return () => {};
}
