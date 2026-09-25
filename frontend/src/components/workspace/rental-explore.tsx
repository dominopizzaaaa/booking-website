'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clock3,
  Compass,
  CreditCard,
  Loader2,
  MapPin,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { AccountRentalHistory } from '@/components/account-rental-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { createRentalReservation, loadRental, loadRentals, loadRentalSlots } from '@/lib/api';
import type { RentalDetail, RentalListing, RentalReservation, RentalSlot, WorkspaceResponse } from '@/lib/types';
import { dateKey, money, shortDate, time } from '@/lib/utils';

type RentalExploreProps = {
  data: WorkspaceResponse;
  onNavigate: (view: string) => void;
};

const managementLinks = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'students', label: 'Students' },
  { id: 'services', label: 'Classes', managerOnly: true },
  { id: 'locations', label: 'Locations' },
  { id: 'team', label: 'My coaches', managerOnly: true },
  { id: 'availability', label: 'Availability' },
  { id: 'packages', label: 'Packages', managerOnly: true },
  { id: 'payments', label: 'Payments', managerOnly: true },
  { id: 'insights', label: 'Insights', managerOnly: true },
] as const;

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
  return `rental-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type RentalFilters = { query: string; sport: string };
const emptyFilters: RentalFilters = { query: '', sport: '' };

export function RentalExplore({ data, onNavigate }: RentalExploreProps) {
  const [rentals, setRentals] = useState<RentalListing[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sport, setSport] = useState('');
  const [submittedFilters, setSubmittedFilters] = useState<RentalFilters>(emptyFilters);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [paginationError, setPaginationError] = useState('');
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const requestGeneration = useRef(0);
  const isManager = data.user.accountType === 'CLUB';
  const links = managementLinks.filter(link => isManager || !('managerOnly' in link && link.managerOnly));

  const load = useCallback(async (filters: RentalFilters, cursor?: string) => {
    const generation = ++requestGeneration.current;
    cursor ? setLoadingMore(true) : setLoading(true);
    cursor ? setPaginationError('') : setError('');
    if (!cursor) {
      setFailedCursor(null);
      setPaginationError('');
    }
    try {
      const result = await loadRentals({
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.sport ? { sport: filters.sport } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (generation !== requestGeneration.current) return;
      setRentals(previous => cursor ? [...previous, ...result.rentals] : result.rentals);
      setNextCursor(result.nextCursor);
      setFailedCursor(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      const message = cause instanceof Error ? cause.message : 'Rentable venues are unavailable right now.';
      if (cursor) {
        setPaginationError(message);
        setFailedCursor(cursor);
      } else {
        setError(message);
        setRentals([]);
        setNextCursor(null);
      }
    } finally {
      if (generation !== requestGeneration.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(emptyFilters);
    return () => { requestGeneration.current += 1; };
  }, [load]);

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const filters = { query: query.trim(), sport: sport.trim() };
    setSubmittedFilters(filters);
    void load(filters);
  }

  return <section className="mx-auto max-w-6xl" aria-labelledby="rental-explore-title">
    <div className="section-heading items-end">
      <div>
        <p className="eyebrow mb-2">PLACES TO PLAY</p>
        <h1 id="rental-explore-title">Explore training grounds</h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[#59675c]">Find a court or training space, see real availability, and reserve it for your next session.</p>
      </div>
    </div>

    <form onSubmit={submitSearch} role="search" className="mb-5 grid gap-2 rounded-xl border border-[#e1e7dd] bg-white p-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,0.35fr)_auto] sm:p-4">
      <label className="relative mb-0">
        <span className="sr-only">Search rentable venues</span>
        <Search aria-hidden="true" size={16} className="pointer-events-none absolute left-3 top-3 text-stone-400" />
        <input value={query} onChange={event => setQuery(event.target.value)} className="!pl-9" placeholder="Venue, club, or area" />
      </label>
      <label className="relative mb-0">
        <span className="sr-only">Filter by sport</span>
        <SlidersHorizontal aria-hidden="true" size={15} className="pointer-events-none absolute left-3 top-3 text-stone-400" />
        <input value={sport} onChange={event => setSport(event.target.value)} className="!pl-9" placeholder="Sport" />
      </label>
      <Button type="submit" disabled={loading}><Search size={14} />Search</Button>
    </form>

    {loading ? <div className="panel grid min-h-48 place-items-center text-xs text-stone-500"><span className="flex items-center gap-2"><Loader2 size={15} className="animate-spin" />Finding available places…</span></div>
      : error ? <div className="panel p-6 text-center"><p role="alert" className="text-xs text-red-700">{error}</p><Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => void load(submittedFilters)}>Try again</Button></div>
        : rentals.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{rentals.map(rental => <article key={rental.id} className="panel flex min-w-0 flex-col overflow-hidden">
        <div className="flex min-h-28 items-end bg-[linear-gradient(135deg,#e8f0e2,#f4eee3)] p-5"><span className="grid h-11 w-11 place-items-center rounded-xl bg-white/85 text-[#64805b] shadow-sm"><MapPin size={21} /></span></div>
          <div className="flex flex-1 flex-col p-5">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="eyebrow mb-1">{rental.sport || 'Multi-sport'}</p><h2 className="truncate text-base text-[#294735]">{rental.name}</h2></div><span className="shrink-0 rounded-full bg-[#eef3e9] px-2 py-1 text-[9px] font-semibold text-[#587250]">{rental.club.name}</span></div>
            <p className="mt-3 flex min-h-9 items-start gap-1.5 text-[11px] leading-relaxed text-stone-500"><MapPin size={12} className="mt-0.5 shrink-0" />{rental.address}</p>
            {rental.amenities.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{rental.amenities.slice(0, 3).map(amenity => <span key={amenity} className="badge bg-stone-100! text-stone-500!">{amenity}</span>)}</div>}
            <div className="mt-auto flex items-end justify-between gap-3 border-t border-[#edf0e8] pt-4"><p><strong className="text-lg text-[#254b38]">{money(rental.price, rental.currency)}</strong><span className="block text-[9px] text-stone-400">per hour</span></p><Button type="button" size="sm" aria-label={`View times for ${rental.name}`} onClick={() => setSelectedId(rental.id)}>View times<ArrowRight size={13} /></Button></div>
          </div>
        </article>)}</div>
          : <div className="panel px-5 py-12 text-center"><Compass size={25} className="mx-auto text-[#91a486]" /><h2 className="mt-4 text-base text-[#294735]">No training grounds matched</h2><p className="mt-2 text-xs text-stone-500">Try a broader venue, area, or sport.</p></div>}

    {(nextCursor || failedCursor) && !loading && <div className="mt-5 flex flex-col items-center gap-3">
      {paginationError && <p role="alert" className="max-w-xl text-center text-xs text-red-700">{paginationError}</p>}
      <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void load(submittedFilters, failedCursor ?? nextCursor!)}>{loadingMore && <Loader2 size={14} className="animate-spin" />}{failedCursor ? 'Try loading more again' : 'Load more venues'}</Button>
    </div>}

    <AccountRentalHistory refreshToken={historyRefreshToken} />

    <section className="mt-7 rounded-2xl border border-[#dfe6d9] bg-[#f7f9f4] p-5" aria-labelledby="workspace-manage-title">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><p className="eyebrow mb-1">YOUR WORKSPACE</p><h2 id="workspace-manage-title" className="text-base text-[#294735]">Manage</h2><p className="mt-1 text-[11px] text-stone-500">Your schedule, {isManager ? 'catalog, team, and finances' : 'students, locations, and availability'}.</p></div></div>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">{links.map(link => <button key={link.id} type="button" onClick={() => onNavigate(link.id)} className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-[#dfe6d9] bg-white px-3 text-[11px] font-semibold text-[#405744] hover:bg-[#f0f4eb]">{link.label}<ArrowRight size={12} /></button>)}</div>
    </section>

    <RentalDialog
      rentalId={selectedId}
      onClose={() => setSelectedId(null)}
      onReserved={() => setHistoryRefreshToken(value => value + 1)}
    />
  </section>;
}

function RentalDialog({ rentalId, onClose, onReserved }: { rentalId: string | null; onClose: () => void; onReserved: () => void }) {
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
  const checkoutAttempt = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!rentalId) {
      setRental(null); setError(''); setSlots([]); setSlotStatus(''); setSlot(null); setReservation(null);
      checkoutAttempt.current = null;
      return;
    }
    let active = true;
    setLoading(true); setError(''); setReservation(null);
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
    if (!rentalId || !rental || !date || !duration) return;
    let active = true;
    setSlotsLoading(true); setSlotStatus(`Checking every ${rental.unitLabel.toLowerCase()} for available times.`); setSlot(null); setSlots([]); setError('');
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
  }, [date, duration, rental, rentalId]);

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
        unitId: slot.unitId,
        startAt: slot.startAt,
        duration,
        idempotencyKey: checkoutAttempt.current.idempotencyKey,
        simulatedOutcome: 'SUCCEEDED',
      });
      if (result.paymentIntent.status === 'REFUNDED') {
        checkoutAttempt.current = null;
        throw new Error('That earlier reservation was already cancelled and refunded. Choose a time and try again.');
      }
      if (!result.reservation) {
        checkoutAttempt.current = null;
        throw new Error('The payment did not complete, so the training ground was not reserved.');
      }
      setReservation(result.reservation);
      onReserved();
      toast.success('Training ground reserved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The reservation could not be completed.');
    } finally {
      setReserving(false);
    }
  }

  return <Dialog open={!!rentalId} onOpenChange={open => { if (!open && !reserving) onClose(); }}>
    <DialogContent className="max-w-2xl" onEscapeKeyDown={event => { if (reserving) event.preventDefault(); }} onPointerDownOutside={event => { if (reserving) event.preventDefault(); }}>
      <DialogTitle className="text-xl font-semibold tracking-tight">{rental?.name || 'Training ground'}</DialogTitle>
      <DialogDescription className="mt-2 text-xs text-stone-500">{rental ? `${rental.sport} · hosted by ${rental.club.name}` : 'Loading venue details…'}</DialogDescription>
      {loading ? <div className="grid min-h-40 place-items-center text-xs text-stone-500"><Loader2 size={16} className="animate-spin" /></div> : rental && !reservation ? <div className="mt-5 space-y-5">
        <div className="grid gap-3 rounded-xl bg-[#f7f9f4] p-4 text-[11px] text-stone-600 sm:grid-cols-2"><p className="flex items-start gap-2"><MapPin size={14} className="mt-0.5 shrink-0" />{rental.address}</p><p className="flex items-center gap-2"><Clock3 size={14} />{rental.minDuration}–{rental.maxDuration} minutes</p></div>
        {rental.amenities.length > 0 && <div><h3 className="text-xs font-semibold text-[#344b39]">Amenities</h3><div className="mt-2 flex flex-wrap gap-2">{rental.amenities.map(amenity => <span key={amenity} className="badge bg-stone-100! text-stone-500!">{amenity}</span>)}</div></div>}
        <div className="form-grid max-sm:grid-cols-1!">
          <div><label htmlFor="rental-date">Date</label><input id="rental-date" type="date" min={dateKey(new Date(), rental.timezone)} max={addCalendarDays(dateKey(new Date(), rental.timezone), rental.advanceDays)} value={date} onChange={event => setDate(event.target.value)} /></div>
          <div><label htmlFor="rental-duration">Duration</label><select id="rental-duration" value={duration} onChange={event => setDuration(Number(event.target.value))}>{durationOptions(rental).map(value => <option value={value} key={value}>{value} minutes</option>)}</select></div>
        </div>
        <div aria-busy={slotsLoading}><h3 className="text-xs font-semibold text-[#344b39]">Available times</h3><p role="status" aria-live="polite" className="sr-only">{slotStatus}</p>{slotsLoading ? <p className="mt-3 flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking every {rental.unitLabel.toLowerCase()}…</p> : slots.length ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{slots.map(candidate => { const selected = slot?.unitId === candidate.unitId && slot.startAt === candidate.startAt; return <button key={`${candidate.unitId}:${candidate.startAt}`} type="button" aria-pressed={selected} onClick={() => setSlot(candidate)} className={`min-h-14 rounded-lg border p-2 text-left text-[11px] ${selected ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-[#dfe5df] hover:bg-[#f5f7f2]'}`}><span className="block font-semibold">{time(candidate.startAt, rental.timezone)}</span><span className={`mt-1 block text-[9px] ${selected ? 'text-white/75' : 'text-stone-500'}`}>{candidate.unitName} · {candidate.price === 0 ? 'Free' : money(candidate.price, rental.currency)}</span></button>; })}</div> : <p className="mt-3 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">No times are available for this date and duration.</p>}</div>
        {rental.rules && <details className="rounded-xl border border-[#e4e8e0] p-4 text-xs"><summary className="cursor-pointer font-semibold text-[#344b39]">Venue rules</summary><p className="mt-3 whitespace-pre-line leading-relaxed text-stone-500">{rental.rules}</p></details>}
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
        <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-[#edf0e8] pt-4 sm:flex-row sm:items-center"><p className="text-[10px] leading-relaxed text-stone-500">{slot?.price === 0 ? 'This reservation is free; no payment is needed.' : 'Payment is simulated; no real card is charged.'} Cancellation closes {rental.cancellationHours} hours before the reservation.</p><Button type="button" disabled={!slot || reserving} onClick={() => void reserve()}>{reserving ? <Loader2 size={14} className="animate-spin" /> : slot?.price === 0 ? <Check size={14} /> : <CreditCard size={14} />}{slot ? slot.price === 0 ? 'Reserve for free' : `Reserve · ${money(slot.price, rental.currency)}` : 'Choose a time'}</Button></div>
      </div> : reservation ? <div role="status" aria-live="polite" className="mt-6 rounded-2xl border border-[#dbe7d2] bg-[#f2f7ed] p-6 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white text-[#608053]"><Check size={22} /></span><h3 ref={confirmationRef} tabIndex={-1} className="mt-4 text-base text-[#294735] focus:outline-none">Reservation confirmed</h3><p className="mt-2 text-xs text-stone-600">{reservation.unitName} · {shortDate(reservation.startAt, reservation.timezone)} at {time(reservation.startAt, reservation.timezone)}</p><p className="mt-1 text-sm font-semibold text-[#254b38]">{reservation.price === 0 ? 'Free' : money(reservation.price, reservation.currency)}</p><p className="mt-2 text-xs text-stone-500">{reservation.price === 0 ? 'No payment was needed.' : 'Payment was simulated; no real card was charged.'}</p><Button type="button" className="mt-5" onClick={onClose}>Done</Button></div> : error ? <p role="alert" className="mt-5 rounded-lg bg-red-50 p-4 text-xs text-red-700">{error}</p> : null}
    </DialogContent>
  </Dialog>;
}
