'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { loadPackageActivity } from '@/lib/api';
import type { CreditEventKind, PackageActivity } from '@/lib/types';
import { dateKey, shortDate, time } from '@/lib/utils';

const kindLabels: Record<CreditEventKind, string> = {
  OPENING_BALANCE: 'Opening balance', GRANTED: 'Credits granted', BOOKED: 'Booked a Class', RESTORED: 'Credit returned',
  RENTAL_RESERVED: 'Reserved a court', RENTAL_RESTORED: 'Court credit returned', ADJUSTED: 'Adjusted by the club',
  USED: 'Credit used', EXPIRED: 'Expired unused',
};

const signed = (delta: number) => delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : '0';

/**
 * Every change to a package's credits, as the database recorded it. This is a
 * read-only ledger: corrections still happen through the ordinary booking and
 * package actions, which then appear here.
 */
export function PackageActivityDialog({ packageId, studentName, timezone, onClose }: { packageId: string; studentName?: string; timezone: string; onClose: () => void }) {
  const [activity, setActivity] = useState<PackageActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setActivity(await loadPackageActivity(packageId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Credit activity could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [packageId]);

  useEffect(() => { void load(); }, [load]);

  const pkg = activity?.package;
  const events = activity ? [...activity.events].reverse() : [];

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl">
      <DialogTitle className="text-xl font-semibold tracking-tight text-[#173f2f]">{pkg ? `${pkg.name} activity` : 'Credit activity'}</DialogTitle>
      <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">{studentName ? `${studentName} · ` : ''}Every credit change, newest first. Recorded automatically and cannot be edited.</DialogDescription>
      <div aria-live="polite" aria-busy={loading} className="mt-5">
        {loading && !activity ? <p className="flex items-center gap-2 py-6 text-xs text-[#59675c]"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading credit activity…</p>
          : error ? <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700"><p role="alert">{error}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void load()}>Try again</Button></div>
            : pkg ? <>
              <dl className="grid grid-cols-3 gap-2 rounded-xl bg-[#f4f7ef] p-3 text-center">
                <div><dt className="text-[11px] text-[#59675c]">Remaining</dt><dd className="mt-1 text-lg font-semibold text-[#254b38]">{pkg.remainingCredits}</dd></div>
                <div><dt className="text-[11px] text-[#59675c]">Used</dt><dd className="mt-1 text-lg font-semibold text-[#254b38]">{pkg.usedCredits}</dd></div>
                <div><dt className="text-[11px] text-[#59675c]">Total</dt><dd className="mt-1 text-lg font-semibold text-[#254b38]">{pkg.totalCredits}</dd></div>
              </dl>
              <p className="!mt-2 text-[11px] text-[#59675c]">{new Date(pkg.expiresAt).getTime() < Date.now() ? 'Expired' : 'Expires'} {shortDate(pkg.expiresAt, timezone)} {dateKey(pkg.expiresAt, timezone).slice(0, 4)}</p>
              {events.length ? <ol className="mt-4 space-y-2" aria-label="Credit changes, newest first">{events.map(event => <li key={event.id} className="flex items-start gap-3 rounded-xl border border-[#e6eae3] p-3">
                <span aria-hidden="true" className={`grid h-9 min-w-9 shrink-0 place-items-center rounded-full px-1 text-xs font-semibold ${event.delta < 0 ? 'bg-[#f6ebd5] text-[#70582e]' : event.delta > 0 ? 'bg-[#e6eedd] text-[#3f5f36]' : 'bg-stone-100 text-stone-600'}`}>{signed(event.delta)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[#294735]">{kindLabels[event.kind] ?? event.kind}<span className="sr-only">, {event.delta === 0 ? 'no change' : `${signed(event.delta).replace('−', 'minus ')} credit${Math.abs(event.delta) === 1 ? '' : 's'}`}</span></p>
                  {event.session && <p className="!mt-0.5 text-[11px] text-[#59675c]">{event.session.serviceName} · {shortDate(event.session.startAt, event.session.timezone)}, {time(event.session.startAt, event.session.timezone)}</p>}
                  {event.note && <p className="!mt-0.5 text-[11px] text-[#59675c]">{event.note}</p>}
                  <p className="!mt-1 text-[11px] text-[#59675c]">{shortDate(event.createdAt, timezone)}, {time(event.createdAt, timezone)} · balance {event.balanceAfter} of {event.totalAfter}</p>
                </div>
              </li>)}</ol>
                : <p className="mt-4 flex items-center gap-2 rounded-xl bg-[#f5f7f1] p-4 text-xs text-[#59675c]"><History size={15} aria-hidden="true" />No credit changes have been recorded yet.</p>}
            </> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
