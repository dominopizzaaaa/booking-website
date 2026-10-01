'use client';

import { Check, Clock3, ListOrdered, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, acceptWaitlistOffer, declineWaitlistOffer, leaveWaitlist, loadAccountWaitlist } from '@/lib/api';
import type { AccountPackage, AccountWaitlistEntry } from '@/lib/types';
import { cn, shortDate, time } from '@/lib/utils';
import {
  aheadText, eligibleWaitlistPackages, isLiveWaitlistEntry, offerCountdown, sortWaitlistEntries,
  waitlistOrderNote, waitlistStatusText,
} from '@/lib/waitlist';
import { ErrorNotice } from './shared';
import { compactButton, eyebrow, field, panel, primaryButton, secondaryButton } from './styles';

type Pending = { id: string; action: 'decline' | 'leave' } | null;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function when(entry: AccountWaitlistEntry) {
  const zone = entry.business.timezone;
  return `${shortDate(entry.booking.startAt, zone)} at ${time(entry.booking.startAt, zone)}`;
}

/**
 * Waitlisted places for full group Classes.
 *
 * Offers come first because they expire; each shows the deadline in the
 * club's time and a countdown that refreshes with the app clock. Waiting
 * places show how many people are queued ahead, never a promised position,
 * because clubs can also offer a place directly. The panel is additive: if
 * the waitlist cannot be loaded it stays out of the way.
 */
export function WaitlistPanel({
  enabled,
  nowMs,
  packages,
  canUsePackages,
  reloadKey,
  onBooked,
}: {
  enabled: boolean;
  nowMs: number;
  packages: AccountPackage[];
  canUsePackages: boolean;
  reloadKey: number;
  onBooked: (bookingId: string | null) => void;
}) {
  const [entries, setEntries] = useState<AccountWaitlistEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [packageChoice, setPackageChoice] = useState<Record<string, string>>({});
  const requestRef = useRef(0);
  const noticeRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!enabled) { setEntries(null); return; }
    const request = ++requestRef.current;
    try {
      const value = await loadAccountWaitlist();
      if (requestRef.current === request) setEntries(value.entries ?? []);
    } catch {
      // An older API, a disabled feature or a signed-out race all mean the
      // same thing here: there is no waitlist to show.
      if (requestRef.current === request) setEntries(null);
    }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh, reloadKey]);

  useEffect(() => {
    if (!notice) return;
    const frame = window.requestAnimationFrame(() => noticeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [notice]);

  if (!entries || entries.length === 0) {
    return notice ? (
      <div ref={noticeRef} tabIndex={-1} role="status" className="mt-7 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847] outline-none">{notice}</div>
    ) : null;
  }

  const sorted = sortWaitlistEntries(entries);
  const live = sorted.filter(isLiveWaitlistEntry);
  const closed = sorted.filter(entry => !isLiveWaitlistEntry(entry));
  const offers = live.filter(entry => entry.status === 'OFFERED').length;

  async function run(entry: AccountWaitlistEntry, action: 'accept' | 'decline' | 'leave') {
    if (busyId) return;
    setBusyId(entry.id);
    setError(null);
    setNotice('');
    try {
      if (action === 'accept') {
        const packageId = packageChoice[entry.id] || undefined;
        const result = await acceptWaitlistOffer(entry.id, packageId);
        setNotice(`You’re booked into ${entry.booking.serviceName} on ${when(entry)}.`);
        onBooked(result.bookings?.[0]?.id ?? null);
      } else if (action === 'decline') {
        await declineWaitlistOffer(entry.id);
        setNotice(`You declined the place in ${entry.booking.serviceName}. It will be offered to the next person.`);
      } else {
        await leaveWaitlist(entry.id);
        setNotice(`You left the waitlist for ${entry.booking.serviceName}.`);
      }
      setPending(null);
    } catch (caught) {
      setError({
        id: entry.id,
        message: caught instanceof ApiError && caught.status === 409
          ? `${messageOf(caught)} The waitlist below shows where things stand now.`
          : messageOf(caught),
      });
    } finally {
      setBusyId(null);
      // Refresh either way: a 409 means the offer moved on (expired, taken or
      // closed) and the list should show its new state.
      void refresh();
    }
  }

  return (
    <section id="student-waitlist" aria-labelledby="student-waitlist-heading" className={cn(panel, 'mt-7 p-5 scroll-mt-24')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f3ead6] text-[#856a33]"><ListOrdered size={18} aria-hidden="true" /></span>
          <div>
            <p className={eyebrow}>Full Classes</p>
            <h2 id="student-waitlist-heading" tabIndex={-1} className="!mt-1 text-lg font-semibold tracking-tight outline-none">Your waitlist</h2>
          </div>
        </div>
        {offers > 0 && (
          <span className="rounded-full bg-[#f6ebd5] px-3 py-1 text-[11px] font-semibold text-[#70582e]">
            {offers === 1 ? '1 place held for you' : `${offers} places held for you`}
          </span>
        )}
      </div>

      {notice && (
        <div ref={noticeRef} tabIndex={-1} role="status" className="mt-4 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847] outline-none">{notice}</div>
      )}
      {error && !live.some(entry => entry.id === error.id) && <div className="mt-4"><ErrorNotice message={error.message} /></div>}

      {live.length > 0 && (
        <ul className="mt-4 space-y-3">
          {live.map(entry => {
            const offered = entry.status === 'OFFERED';
            const countdown = offerCountdown(entry.offerExpiresAt, nowMs);
            const eligible = canUsePackages ? eligibleWaitlistPackages(entry, packages) : [];
            const confirming = pending?.id === entry.id ? pending.action : null;
            const busy = busyId === entry.id;
            const zone = entry.business.timezone;
            return (
              <li key={entry.id}>
                <article
                  aria-labelledby={`waitlist-${entry.id}-title`}
                  className={cn('rounded-xl border p-4', offered ? 'border-[#e7d4a8] bg-[#fdf8ec]' : 'border-[#e4e9df] bg-[#fafbf8]')}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 id={`waitlist-${entry.id}-title`} className="text-sm font-semibold text-[#304b39]">{entry.booking.serviceName}</h3>
                      <p className="!mt-1 text-xs text-[#59675c]">{when(entry)} · {entry.business.name}</p>
                      <p className="!mt-0.5 text-xs text-[#59675c]">{entry.booking.instructorName} · {entry.booking.locationName}</p>
                    </div>
                    <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold', offered ? 'bg-[#f6ebd5] text-[#70582e]' : 'bg-[#e8edf2] text-[#4f687d]')}>
                      {waitlistStatusText(entry.status)}
                    </span>
                  </div>

                  {offered ? (
                    <>
                      <p className={cn('!mt-3 inline-flex items-center gap-1.5 text-xs font-semibold', countdown.urgent || countdown.expired ? 'text-[#8b4d3c]' : 'text-[#70582e]')}>
                        <Clock3 size={13} aria-hidden="true" /> {countdown.text}
                      </p>
                      {entry.offerExpiresAt && !countdown.expired && (
                        <p className="!mt-1 text-xs text-[#70582e]">
                          Confirm by {shortDate(entry.offerExpiresAt, zone)} at {time(entry.offerExpiresAt, zone)} or it passes to the next person.
                        </p>
                      )}
                      {eligible.length > 0 && !countdown.expired && (
                        <div className="mt-3">
                          <label htmlFor={`waitlist-${entry.id}-package`} className="text-xs font-semibold text-[#465e4c]">How to pay</label>
                          <select
                            id={`waitlist-${entry.id}-package`}
                            value={packageChoice[entry.id] ?? ''}
                            disabled={busy}
                            onChange={(event) => setPackageChoice(current => ({ ...current, [entry.id]: event.target.value }))}
                            className={cn(field, 'mt-2 w-full bg-white')}
                          >
                            <option value="">Pay the club later from the booking</option>
                            {eligible.map(pkg => (
                              <option key={pkg.id} value={pkg.id}>Use 1 credit from {pkg.name} ({pkg.remainingCredits} left)</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {error?.id === entry.id && <div className="mt-3"><ErrorNotice message={error.message} /></div>}
                      {confirming === 'decline' ? (
                        <div className="mt-3 rounded-xl border border-[#e7d4ca] bg-white p-3">
                          <p className="text-xs leading-relaxed text-[#70582e]">Decline this place? It will be offered to the next person and cannot be reclaimed.</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" className={compactButton} disabled={busy} onClick={() => setPending(null)}>Keep the offer</button>
                            <button type="button" disabled={busy} onClick={() => void run(entry, 'decline')} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-[#8b4d3c] px-3 text-xs font-semibold text-white hover:bg-[#743e31] disabled:opacity-50">
                              {busy ? <LoaderCircle size={13} className="animate-spin" /> : <X size={13} aria-hidden="true" />} Yes, decline
                            </button>
                          </div>
                        </div>
                      ) : !countdown.expired && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button type="button" className={primaryButton} disabled={busy} onClick={() => void run(entry, 'accept')}>
                            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} aria-hidden="true" />} Confirm my place
                          </button>
                          <button type="button" className={secondaryButton} disabled={busy} onClick={() => { setError(null); setPending({ id: entry.id, action: 'decline' }); }}>
                            Decline
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="!mt-3 text-sm font-semibold text-[#304b39]">{aheadText(entry.aheadCount)}</p>
                      <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">{waitlistOrderNote} We’ll alert you if a place is held for you.</p>
                      {error?.id === entry.id && <div className="mt-3"><ErrorNotice message={error.message} /></div>}
                      {confirming === 'leave' ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-[#59675c]">Leave this waitlist?</span>
                          <button type="button" className={compactButton} disabled={busy} onClick={() => setPending(null)}>Stay on it</button>
                          <button type="button" className={compactButton} disabled={busy} onClick={() => void run(entry, 'leave')}>
                            {busy && <LoaderCircle size={13} className="animate-spin" />} Yes, leave
                          </button>
                        </div>
                      ) : (
                        <button type="button" className={cn(compactButton, 'mt-3')} disabled={busy} onClick={() => { setError(null); setPending({ id: entry.id, action: 'leave' }); }}>
                          Leave waitlist
                        </button>
                      )}
                    </>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {closed.length > 0 && (
        <details className="mt-4 rounded-xl border border-[#edf0e8] px-4 py-3">
          <summary className="min-h-8 cursor-pointer text-xs font-semibold text-[#344d40]">
            Recent waitlist updates ({closed.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {closed.map(entry => (
              <li key={entry.id} className="text-xs leading-relaxed text-[#59675c]">
                <strong className="font-semibold text-[#415244]">{entry.booking.serviceName}</strong> · {when(entry)} — {waitlistStatusText(entry.status)}
                {entry.closedReason ? `: ${entry.closedReason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
