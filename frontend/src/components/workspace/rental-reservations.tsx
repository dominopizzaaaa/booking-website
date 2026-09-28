'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadRentalReservations } from '@/lib/api';
import type { RentalPaymentStatus, RentalReservation, RentalReservationFilters, RentalReservationStatus } from '@/lib/types';
import { money, shortDate, time } from '@/lib/utils';

type Filters = { from: string; to: string; status: '' | RentalReservationStatus; paymentStatus: '' | RentalPaymentStatus; q: string };
const empty: Filters = { from: '', to: '', status: '', paymentStatus: '', q: '' };
const requestValues = (filters: Filters): RentalReservationFilters => ({ ...filters, status: filters.status || undefined, paymentStatus: filters.paymentStatus || undefined, q: filters.q.trim() || undefined });

export function RentalReservations() {
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<Filters>(empty);
  const [reservations, setReservations] = useState<RentalReservation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const resultStatus = loading
    ? 'Loading rental reservations.'
    : loadingMore
      ? 'Loading more rental reservations.'
      : `${reservations.length} rental ${reservations.length === 1 ? 'reservation' : 'reservations'} loaded.`;

  const load = useCallback(async (value: Filters, cursor?: string) => {
    const current = ++generation.current;
    cursor ? setLoadingMore(true) : setLoading(true); setError('');
    try {
      const result = await loadRentalReservations({ ...requestValues(value), ...(cursor ? { cursor } : {}), limit: 30 });
      if (current !== generation.current) return;
      setReservations(previous => cursor ? [...previous, ...result.reservations] : result.reservations);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'Rental reservations could not be loaded.');
      if (!cursor) { setReservations([]); setNextCursor(null); }
    } finally { if (current === generation.current) { setLoading(false); setLoadingMore(false); } }
  }, []);

  useEffect(() => { void load(filters); return () => { generation.current += 1; }; }, [filters, load]);

  return <section aria-labelledby="rental-reservations-title">
    <div className="mb-5"><p className="eyebrow mb-2">CLUB OPERATIONS</p><h2 id="rental-reservations-title" className="text-xl">Rental reservations</h2><p className="mt-2 text-xs text-[#59675c]">Review bookings made against this club's rentable courts and spaces.</p></div>
    <form role="search" onSubmit={event => { event.preventDefault(); setFilters({ ...draft, q: draft.q.trim() }); }} className="panel mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
      <label className="relative sm:col-span-2 lg:col-span-1"><span className="mb-1 block text-xs font-medium">Search</span><Search size={14} className="pointer-events-none absolute left-3 top-9 text-stone-400" /><input className="!pl-9" value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} placeholder="Guest, venue, unit, or ID" /></label>
      <Filter label="From date (inclusive)"><input type="date" value={draft.from} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></Filter>
      <Filter label="To date (inclusive)"><input type="date" min={draft.from || undefined} value={draft.to} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></Filter>
      <Filter label="Reservation"><select value={draft.status} onChange={event => setDraft(value => ({ ...value, status: event.target.value as Filters['status'] }))}><option value="">All statuses</option>{['CONFIRMED', 'PENDING', 'COMPLETED', 'CANCELLED'].map(value => <option key={value}>{value}</option>)}</select></Filter>
      <Filter label="Payment"><select value={draft.paymentStatus} onChange={event => setDraft(value => ({ ...value, paymentStatus: event.target.value as Filters['paymentStatus'] }))}><option value="">All payments</option>{['PAID', 'PACKAGE', 'UNPAID', 'REFUNDED'].map(value => <option key={value}>{value}</option>)}</select></Filter>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5"><Button type="submit" disabled={loading}>Apply filters</Button><Button type="button" variant="ghost" onClick={() => { setDraft(empty); setFilters(empty); }}><X size={14} />Clear</Button></div>
    </form>
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{resultStatus}</p>
    <div aria-busy={loading || loadingMore}>{loading ? <div className="panel grid min-h-48 place-items-center text-xs text-stone-500"><span className="flex items-center gap-2"><Loader2 size={15} className="animate-spin" />Loading reservations…</span></div> : error && !reservations.length ? <div className="panel p-8 text-center"><p role="alert" className="text-xs text-red-700">{error}</p><Button variant="outline" className="mt-4" onClick={() => void load(filters)}>Try again</Button></div> : reservations.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{reservations.map(reservation => <ReservationCard key={reservation.id} reservation={reservation} />)}</div> : <div className="panel p-10 text-center"><CalendarDays size={23} className="mx-auto text-[#91a486]" /><p className="mt-3 text-sm font-semibold text-[#294735]">No rental reservations found</p><p className="mt-1 text-xs text-stone-500">New reservations will appear here when guests book your spaces.</p></div>}</div>
    {error && reservations.length > 0 && <p role="alert" className="mt-4 text-center text-xs text-red-700">{error}</p>}
    {nextCursor && <div className="mt-5 text-center"><Button variant="outline" disabled={loadingMore} onClick={() => void load(filters, nextCursor)}>{loadingMore && <Loader2 size={14} className="animate-spin" />}Load more reservations</Button></div>}
  </section>;
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) { return <label><span className="mb-1 block text-xs font-medium">{label}</span>{children}</label>; }
function ReservationCard({ reservation }: { reservation: RentalReservation }) {
  return <article className="panel flex min-w-0 flex-col p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="eyebrow mb-1">{reservation.unitName}</p><h3 className="break-words text-base text-[#294735]">{reservation.locationName}</h3><p className="mt-1 break-words text-xs text-[#59675c]">Reserved by {reservation.renterName}</p></div><span className={'badge ' + (reservation.status === 'CANCELLED' ? 'cancelled' : reservation.status === 'PENDING' ? 'pending' : '')}>{reservation.status.toLowerCase()}</span></div><dl className="mt-4 grid grid-cols-2 gap-4 text-xs"><div><dt className="text-[10px] uppercase tracking-wide text-stone-400">Date</dt><dd className="mt-1">{shortDate(reservation.startAt, reservation.timezone)}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-stone-400">Time</dt><dd className="mt-1">{time(reservation.startAt, reservation.timezone)}–{time(reservation.endAt, reservation.timezone)}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-stone-400">Amount</dt><dd className="mt-1 font-semibold text-[#254b38]">{money(reservation.price, reservation.currency)}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-stone-400">Payment</dt><dd className="mt-1">{reservation.paymentStatus.toLowerCase()}</dd></div></dl><p className="mt-4 break-all border-t border-[#edf0e8] pt-3 text-[10px] text-stone-400">Reference {reservation.id}</p></article>;
}
