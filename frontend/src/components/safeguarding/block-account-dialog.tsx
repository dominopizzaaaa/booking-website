'use client';

import { Loader2, UserRoundX } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export function BlockAccountDialog({ target, busy, onClose, onConfirm }: {
  target: { name: string; username: string } | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent
      className="max-w-md"
      aria-busy={busy}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#fff0eb] text-[#a64d38]"><UserRoundX size={20} aria-hidden="true" /></div>
      <DialogTitle className="mt-4 text-xl font-semibold tracking-tight text-[#263a30]">Block {target?.name}?</DialogTitle>
      <DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">
        Direct messages between you and @{target?.username} will stop. Your message history stays visible. Reporting a concern is a separate action, and communications attached to session bookings are unaffected.
      </DialogDescription>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" disabled={busy} onClick={onClose} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#dfe5df] px-4 text-sm font-semibold text-[#33443b] hover:bg-[#f2f5f1] disabled:opacity-60">Keep messages open</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#8f4938] px-4 text-sm font-semibold text-white hover:bg-[#793b2e] disabled:opacity-60">
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Block account
        </button>
      </div>
    </DialogContent>
  </Dialog>;
}
