'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Hourglass, Loader2, Send, UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { loadBookingWaitlist, offerWaitlistPlace, removeWaitlistEntry } from '@/lib/api';
import type { ProviderWaitlist, ProviderWaitlistEntry, WaitlistStatus } from '@/lib/types';
import { shortDate, time } from '@/lib/utils';

const statusLabels: Record<WaitlistStatus, string> = {
  WAITING: 'Waiting', OFFERED: 'Place offered', ACCEPTED: 'Booked', DECLINED: 'Declined', EXPIRED: 'Offer expired',
  WITHDRAWN: 'Left the waitlist', REMOVED: 'Removed by the club', CLOSED: 'Closed',
};

const live = (entry: ProviderWaitlistEntry) => entry.status === 'WAITING' || entry.status === 'OFFERED';

/**
 * The queue for a full group Class.
 *
 * Offers normally go out automatically in order; the manual offer exists for
 * the club that knows something the queue does not, and is only possible
 * while a place is actually free.
 */
export function WaitlistPanel({ bookingId, timezone, onChanged }: { bookingId: string; timezone: string; onChanged?: () => Promise<void> | void }) {
  const [waitlist, setWaitlist] = useState<ProviderWaitlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderWaitlistEntry | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setWaitlist(await loadBookingWaitlist(bookingId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The waitlist could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => { void load(); }, [load]);

  async function act(entry: ProviderWaitlistEntry, kind: 'offer' | 'remove') {
    setBusyId(entry.id);
    try {
      if (kind === 'offer') await offerWaitlistPlace(entry.id);
      else await removeWaitlistEntry(entry.id);
      toast.success(kind === 'offer' ? `Place offered to ${entry.studentName}` : `${entry.studentName} removed from the waitlist`);
      setConfirmRemove(null);
      await load();
      // The row's controls may have just disappeared; keep focus in the panel.
      headingRef.current?.focus();
      await onChanged?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The waitlist could not be updated.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const entries = waitlist?.entries ?? [];
  const liveEntries = entries.filter(live);
  const closedEntries = entries.filter(entry => !live(entry));
  const visible = showClosed ? entries : liveEntries;
  const headingId = `waitlist-heading-${bookingId}`;

  return <section aria-labelledby={headingId} className="mt-5 rounded-xl border border-[#e3e8df] p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="flex outline-none items-center gap-2 text-xs text-[#344b39]"><Hourglass size={14} aria-hidden="true" />Waitlist</h3>
      {waitlist && <p className="text-[11px] text-[#59675c]">{liveEntries.length} waiting or offered · {waitlist.placesFree} place{waitlist.placesFree === 1 ? '' : 's'} free</p>}
    </div>
    <div aria-live="polite" aria-busy={loading}>
      {loading && !waitlist ? <p className="mt-3 flex items-center gap-2 text-xs text-[#59675c]"><Loader2 size={13} className="animate-spin" aria-hidden="true" />Loading the waitlist…</p>
        : error ? <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700"><p role="alert">{error}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void load()}>Try again</Button></div>
          : !visible.length ? <p className="mt-3 text-xs leading-relaxed text-[#59675c]">{entries.length ? 'Nobody is waiting right now.' : 'Nobody has joined the waitlist. Students can join from your booking page once this Class is full.'}</p>
            : <ol className="mt-3 space-y-2">{visible.map(entry => {
              const canOffer = !!waitlist?.canManage && entry.status === 'WAITING' && (waitlist?.placesFree ?? 0) > 0;
              const canRemove = !!waitlist?.canManage && live(entry);
              return <li key={entry.id} className="rounded-lg bg-[#f7f9f4] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#294735]">{entry.position ? <span className="mr-1.5 text-[#59675c]">#{entry.position}</span> : null}{entry.studentName}</p>
                    <p className="mt-1 text-[11px] text-[#59675c]">
                      {statusLabels[entry.status]}
                      {entry.status === 'OFFERED' && entry.offerExpiresAt ? ` · held until ${shortDate(entry.offerExpiresAt, timezone)}, ${time(entry.offerExpiresAt, timezone)}` : ''}
                      {entry.status === 'WAITING' ? ` · joined ${shortDate(entry.createdAt, timezone)}` : ''}
                    </p>
                  </div>
                  {(canOffer || canRemove) && <div className="flex flex-wrap gap-2">
                    {canOffer && <Button type="button" size="sm" variant="outline" disabled={!!busyId} onClick={() => void act(entry, 'offer')}>{busyId === entry.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}Offer place<span className="sr-only"> to {entry.studentName}</span></Button>}
                    {canRemove && <Button type="button" size="sm" variant="ghost" disabled={!!busyId} onClick={() => setConfirmRemove(entry)}><UserMinus size={13} aria-hidden="true" />Remove<span className="sr-only"> {entry.studentName}</span></Button>}
                  </div>}
                </div>
                {confirmRemove?.id === entry.id && <div role="region" aria-label={`Remove ${entry.studentName} from the waitlist`} className="mt-3 rounded-lg border border-[#e5c8be] bg-[#fff7f3] p-3">
                  <p className="text-xs leading-relaxed text-[#704c42]">Remove {entry.studentName} from this waitlist? {entry.status === 'OFFERED' ? 'The place held for them passes to the next person.' : 'They keep their account and can join again while the Class is full.'}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" autoFocus disabled={!!busyId} onClick={() => setConfirmRemove(null)}>Keep on waitlist</Button>
                    <Button type="button" size="sm" variant="destructive" disabled={!!busyId} onClick={() => void act(entry, 'remove')}>{busyId === entry.id && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}Remove from waitlist</Button>
                  </div>
                </div>}
              </li>;
            })}</ol>}
    </div>
    {closedEntries.length > 0 && <Button type="button" size="sm" variant="ghost" className="mt-2 -ml-2" aria-expanded={showClosed} onClick={() => setShowClosed(value => !value)}>{showClosed ? 'Hide closed entries' : `Show ${closedEntries.length} closed entr${closedEntries.length === 1 ? 'y' : 'ies'}`}</Button>}
    {waitlist && waitlist.placesFree === 0 && liveEntries.some(entry => entry.status === 'WAITING') && waitlist.canManage && <p className="mt-2 text-[11px] leading-relaxed text-[#59675c]">Offers go out in order when a place frees up. You can offer a place by hand only while one is free.</p>}
  </section>;
}
