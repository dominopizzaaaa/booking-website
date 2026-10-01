import { Router } from 'express';

// Implemented by the credit-ledger workstream. See docs/TRAINING_COMPANION.md.
export const packageActivityAccountRouter = Router();
export const packageActivityWorkspaceRouter = Router();

export function startPackageAlertWorker(): () => void {
  return () => {};
}
