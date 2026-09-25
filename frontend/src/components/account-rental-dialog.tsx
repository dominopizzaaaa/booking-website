'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, Clock3, CreditCard, Loader2, MapPin, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cancelRentalReservation, createRentalReservation, loadAccountRentalReservations, loadRental, loadRentalSlots } from '@/lib/api';
import type { RentalDetail, RentalReservation, RentalSlot } from '@/lib/types';
import { dateKey, money, shortDate, time } from '@/lib/utils';

function durationOptions(rental: RentalDetail) {
  const values: number[] = [];
  const step = Math.max(1, rental.durationIncrement);
  for (let value = rental.minDuration; value <= rental.maxDuration; value += step) values.push(value);
  return values;
}

function addCalendarDays(key: string, days: number) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function requestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `account-rental-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function reservationStatus(reservation: RentalReservation) {
  if (reservation.status === 'CANCELLED') return 'Cancelled';
  if (reservation.status === 'PENDING') return 'Pending';
  return 'Confirmed';
}

function paymentStatus(reservation: RentalReservation) {
  if (reservation.price === 0) return 'Free reservation';
  if (reservation.paymentStatus === 'REFUNDED' && reservation.packageId) return 'Package credit restored';
  if (reservation.paymentStatus === 'REFUNDED') return 'Simulated payment refunded';
  if (reservation.paymentStatus === 'PACKAGE') return 'Package credit used';
  if (reservation.paymentStatus === 'PAID') return 'Paid with simulated Stripe';
  return 'Payment pending';
}

function reservationStatusClass(reservation: RentalReservation) {
  if (reservation.status === 'CANCELLED') return 'bg-red-50 text-red-700';
  if (reservation.status === 'PENDING') return 'bg-amber-50 text-amber-800';
  return 'bg-[#edf5e8] text-[#47663f]';
}

export function AccountRentalHistory({
  refreshToken = 0,
  onCancelled,
}: {
  refreshToken?: number;
  onCancelled?: (reservation: RentalReservation) => void;
}) {
  const [reservations, setReservations] = useState<RentalReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelTarget, setCancelTarget] = useState<RentalReservation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const loadRequestRef = useRef(0);

  const loadReservations = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await loadAccountRentalReservations();
      if (loadRequestRef.current === requestId) setReservations(result.reservations);
    } catch (cause) {
      if (loadRequestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : 'Your rental reservations could not be loaded.');
      }
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadReservations(); }, [loadReservations, refreshToken]);
  useEffect(() => {
    if (!notice) return;
    const frame = window.requestAnimationFrame(() => noticeRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [notice]);

  async function confirmCancellation() {
    if (!cancelTarget || cancelling) return;
    const restoredPackageCredit = !!cancelTarget.packageId && cancelTarget.creditConsumed;
    const freeReservation = cancelTarget.price === 0;
    setCancelling(true);
    setError('');
    setNotice('');
    try {
      const result = await cancelRentalReservation(cancelTarget.id);
      loadRequestRef.current += 1;
      setLoading(false);
      setReservations(current => current.map(item => item.id === result.reservation.id ? result.reservation : item));
      setCancelTarget(null);
      setNotice(freeReservation
        ? 'Rental cancelled. No payment or package credit was needed.'
        : restoredPackageCredit
        ? 'Rental cancelled. One package credit was restored.'
        : 'Rental cancelled. The simulated payment was refunded; no real card was charged.');
      onCancelled?.(result.reservation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This rental reservation could not be cancelled.');
    } finally {
      setCancelling(false);
    }
  }

  return <>
    <section className="my-5 rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-rental-history-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <CalendarDays size={19} className="mt-0.5 shrink-0 text-[#6f865f]" />
          <div>
            <h2 id="account-rental-history-heading" className="text-base text-[#405941]">My rental reservations</h2>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">Reservations follow this account across clubs. Card payments shown here are simulated; no real card was charged.</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void loadReservations()}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {notice && <p ref={noticeRef} tabIndex={-1} role="status" className="mt-4 rounded-xl bg-[#edf5e8] p-3 text-xs text-[#47663f] focus:outline-none">{notice}</p>}
      {error && !cancelTarget && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {loading && reservations.length === 0 ? (
        <p role="status" className="mt-5 flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Loading rental reservations…</p>
      ) : reservations.length ? (
        <div className="mt-5 space-y-3">
          {reservations.map(item => (
            <article key={item.id} className="min-w-0 rounded-xl border border-[#e4e9df] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-[#344b39]">{item.locationName}</h3>
                  <p className="mt-1 text-xs font-medium text-[#59675c]">{item.businessName}</p>
                  <p className="mt-1 text-xs text-stone-500">{item.unitName} · {shortDate(item.startAt, item.timezone)} · {time(item.startAt, item.timezone)}–{time(item.endAt, item.timezone)}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${reservationStatusClass(item)}`}>{reservationStatus(item)}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <p className="font-semibold text-[#47634d]">{item.price === 0 ? 'Free reservation' : `${paymentStatus(item)} · ${money(item.price, item.currency)}`}</p>
                {item.cancellable && item.status !== 'CANCELLED' ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => { setNotice(''); setError(''); setCancelTarget(item); }}>Cancel reservation</Button>
                ) : item.status !== 'CANCELLED' ? (
                  <span className="text-[11px] text-stone-500">Cancellation window closed</span>
                ) : null}
              </div>
              {item.status !== 'CANCELLED' && (
                <p className="mt-2 text-[10px] text-stone-500">Cancel by {shortDate(item.cancellationDeadline, item.timezone)} at {time(item.cancellationDeadline, item.timezone)}</p>
              )}
            </article>
          ))}
        </div>
      ) : !error ? (
        <p className="mt-5 rounded-xl bg-[#f7f9f4] p-4 text-xs text-stone-500">No rental reservations yet. A reservation will stay here after you close its confirmation.</p>
      ) : null}
    </section>

    <Dialog open={!!cancelTarget} onOpenChange={open => { if (!open && !cancelling) { setCancelTarget(null); setError(''); } }}>
      <DialogContent className="max-w-md" onEscapeKeyDown={event => { if (cancelling) event.preventDefault(); }} onPointerDownOutside={event => { if (cancelling) event.preventDefault(); }}>
        <DialogTitle className="text-xl font-semibold tracking-tight">Cancel rental reservation?</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">
          {cancelTarget ? `${cancelTarget.locationName} · ${cancelTarget.businessName} · ${cancelTarget.unitName} · ${shortDate(cancelTarget.startAt, cancelTarget.timezone)} at ${time(cancelTarget.startAt, cancelTarget.timezone)}` : ''}
        </DialogDescription>
        {cancelTarget && <p className="mt-5 rounded-xl bg-[#f7f9f4] p-4 text-xs leading-relaxed text-stone-600">{cancelTarget.price === 0
          ? 'Cancelling releases this time. No payment or package credit needs to be refunded.'
          : cancelTarget.packageId && cancelTarget.creditConsumed
          ? 'Cancelling restores one package credit.'
          : 'Cancelling refunds the simulated payment. No real card was charged.'}</p>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={cancelling} onClick={() => { setCancelTarget(null); setError(''); }}>Keep reservation</Button>
          <Button type="button" disabled={cancelling} onClick={() => void confirmCancellation()}>
            {cancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Cancel reservation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function AccountRentalDialog({ rentalId, onClose }: { rentalId: string | null; onClose: () => void }) {
  const [rental, setRental] = useState<RentalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [date, setDate] = useState(dateKey());
  const [duration, setDuration] = useState(60);
  const [slots, setSlots] = useState<RentalSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotStatus, setSlotStatus] = useState('');
  const [slot, setSlot] = useState<RentalSlot | null>(null);
  const [reserving, setReserving] = useState(false);
  const [reservation, setReservation] = useState<RentalReservation | null>(null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const checkoutAttempt = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!rentalId) {
      setRental(null); setError(''); setSlots([]); setSlotStatus(''); setSlot(null); setReservation(null);
      checkoutAttempt.current = null;
      return;
    }
    let active = true;
    setLoading(true); setError(''); setRental(null); setReservation(null);
    loadRental(rentalId)
      .then(result => {
        if (!active) return;
        setRental(result);
        setDuration(result.minDuration);
        setDate(addCalendarDays(dateKey(new Date(), result.timezone), 1));
        checkoutAttempt.current = null;
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'This venue could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [rentalId]);

  useEffect(() => {
    if (!rentalId || !rental || !date || !duration || reservation) return;
    let active = true;
    setSlotsLoading(true);
    setSlotStatus(`Checking every ${rental.unitLabel.toLowerCase()} for available times.`);
    setSlot(null); setSlots([]); setError('');
    loadRentalSlots(rentalId, { date, duration })
      .then(result => {
        if (!active) return;
        setSlots(result.slots);
        setSlotStatus(result.slots.length === 1 ? '1 available time loaded.' : `${result.slots.length} available times loaded.`);
      })
      .catch(cause => {
        if (!active) return;
        setSlotStatus('Available times could not be loaded.');
        setError(cause instanceof Error ? cause.message : 'Available times could not be loaded.');
      })
      .finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [date, duration, rental, rentalId, reservation]);

  useEffect(() => {
    if (!reservation) return;
    const frame = window.requestAnimationFrame(() => confirmationRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [reservation]);

  async function reserve() {
    if (!rentalId || !slot) return;
    const signature = `${rentalId}:${slot.unitId}:${slot.startAt}:${duration}`;
    if (checkoutAttempt.current?.signature !== signature) {
      checkoutAttempt.current = { signature, idempotencyKey: requestId() };
    }
    setReserving(true); setError('');
    try {
      const result = await createRentalReservation(rentalId, {
        unitId: slot.unitId, startAt: slot.startAt, duration,
        idempotencyKey: checkoutAttempt.current.idempotencyKey, simulatedOutcome: 'SUCCEEDED',
      });
      if (result.paymentIntent.status === 'REFUNDED') {
        checkoutAttempt.current = null;
        throw new Error('That earlier reservation was already cancelled and refunded. Choose a time and try again.');
      }
      if (!result.reservation) {
        checkoutAttempt.current = null;
        throw new Error('The payment did not complete, so the venue was not reserved.');
      }
      setReservation(result.reservation);
      setHistoryRefreshToken(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The reservation could not be completed.');
    } finally {
      setReserving(false);
    }
  }

  return <><AccountRentalHistory refreshToken={historyRefreshToken} /><Dialog open={!!rentalId} onOpenChange={open => { if (!open && !reserving) onClose(); }}>
    <DialogContent className="max-w-2xl" onEscapeKeyDown={event => { if (reserving) event.preventDefault(); }} onPointerDownOutside={event => { if (reserving) event.preventDefault(); }}>
      <DialogTitle className="text-xl font-semibold tracking-tight">{rental?.name || 'Rental venue'}</DialogTitle>
      <DialogDescription className="mt-2 text-xs text-stone-500">{rental ? `${rental.sport || 'Multi-sport'} · hosted by ${rental.club.name}` : 'Loading venue details…'}</DialogDescription>
      {loading ? <div className="grid min-h-40 place-items-center text-xs text-stone-500"><Loader2 size={16} className="animate-spin" /><span className="sr-only">Loading venue details</span></div>
        : rental && !reservation ? <div className="mt-5 space-y-5">
          <div className="grid gap-3 rounded-xl bg-[#f7f9f4] p-4 text-xs text-stone-600 sm:grid-cols-2"><p className="flex items-start gap-2"><MapPin size={14} className="mt-0.5 shrink-0" />{rental.address}</p><p className="flex items-center gap-2"><Clock3 size={14} />{rental.minDuration}–{rental.maxDuration} minutes</p></div>
          {rental.amenities.length > 0 && <div><h3 className="text-sm font-semibold text-[#344b39]">Amenities</h3><div className="mt-2 flex flex-wrap gap-2">{rental.amenities.map(amenity => <span key={amenity} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">{amenity}</span>)}</div></div>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor="account-rental-date">Date</label><input id="account-rental-date" type="date" min={dateKey(new Date(), rental.timezone)} max={addCalendarDays(dateKey(new Date(), rental.timezone), rental.advanceDays)} value={date} onChange={event => setDate(event.target.value)} /></div>
            <div><label htmlFor="account-rental-duration">Duration</label><select id="account-rental-duration" value={duration} onChange={event => setDuration(Number(event.target.value))}>{durationOptions(rental).map(value => <option value={value} key={value}>{value} minutes</option>)}</select></div>
          </div>
          <div aria-busy={slotsLoading}><h3 className="text-sm font-semibold text-[#344b39]">Available times</h3><p role="status" aria-live="polite" className="sr-only">{slotStatus}</p>{slotsLoading ? <p className="mt-3 flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking every {rental.unitLabel.toLowerCase()}…</p> : slots.length ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{slots.map(candidate => { const selected = slot?.unitId === candidate.unitId && slot.startAt === candidate.startAt; return <button key={`${candidate.unitId}:${candidate.startAt}`} type="button" aria-pressed={selected} onClick={() => setSlot(candidate)} className={`min-h-14 rounded-lg border p-2 text-left text-xs ${selected ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-[#dfe5df] hover:bg-[#f5f7f2]'}`}><span className="block font-semibold">{time(candidate.startAt, rental.timezone)}</span><span className={`mt-1 block text-xs ${selected ? 'text-white/80' : 'text-stone-500'}`}>{candidate.unitName} · {candidate.price === 0 ? 'Free' : money(candidate.price, rental.currency)}</span></button>; })}</div> : <p className="mt-3 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">No times are available for this date and duration.</p>}</div>
          {rental.rules && <details className="rounded-xl border border-[#e4e8e0] p-4 text-xs"><summary className="cursor-pointer font-semibold text-[#344b39]">Venue rules</summary><p className="mt-3 whitespace-pre-line leading-relaxed text-stone-500">{rental.rules}</p></details>}
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
          <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-[#edf0e8] pt-4 sm:flex-row sm:items-center"><p className="text-xs leading-relaxed text-stone-500">{slot?.price === 0 ? 'This reservation is free; no payment or package credit is needed.' : 'Payment is simulated; no real card is charged.'} Cancellation closes {rental.cancellationHours} hours before the reservation.</p><Button type="button" disabled={!slot || reserving} onClick={() => void reserve()}>{reserving ? <Loader2 size={14} className="animate-spin" /> : slot?.price === 0 ? <Check size={14} /> : <CreditCard size={14} />}{slot ? slot.price === 0 ? 'Reserve for free' : `Reserve · ${money(slot.price, rental.currency)}` : 'Choose a time'}</Button></div>
        </div>
          : reservation ? <div role="status" aria-live="polite" className="mt-6 rounded-2xl border border-[#dbe7d2] bg-[#f2f7ed] p-6 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white text-[#608053]"><Check size={22} /></span><h3 ref={confirmationRef} tabIndex={-1} className="mt-4 text-base text-[#294735] focus:outline-none">Reservation confirmed</h3><p className="mt-2 text-xs text-stone-600">{reservation.unitName} · {shortDate(reservation.startAt, reservation.timezone)} at {time(reservation.startAt, reservation.timezone)}</p><p className="mt-1 text-sm font-semibold text-[#254b38]">{reservation.price === 0 ? 'Free' : money(reservation.price, reservation.currency)}</p><p className="mt-2 text-xs text-stone-500">{reservation.price === 0 ? 'No payment or package credit was needed.' : 'Payment was simulated; no real card was charged.'}</p><Button type="button" className="mt-5" onClick={onClose}>Done</Button></div>
            : error ? <p role="alert" className="mt-5 rounded-lg bg-red-50 p-4 text-xs text-red-700">{error}</p> : null}
    </DialogContent>
  </Dialog></>;
}
