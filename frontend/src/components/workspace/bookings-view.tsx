'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { downloadBookingsCsv, loadBookings } from '@/lib/api';
import type { BookingListFilters, Status, WorkspaceBooking, WorkspaceResponse } from '@/lib/types';
import { dateKey, shortDate, time } from '@/lib/utils';

type Props = { data: WorkspaceResponse; onBooking: (id: string) => void; onNew?: () => void };
type Filters = { from: string; to: string; status: '' | Status; instructorId: string; locationId: string; serviceId: string; q: string; sort: 'asc' | 'desc' };
const initial = (timezone: string): Filters => ({ from: dateKey(new Date(), timezone), to: '', status: '', instructorId: '', locationId: '', serviceId: '', q: '', sort: 'asc' });
const requestValues = (value: Filters): BookingListFilters => ({ ...value, status: value.status || undefined, instructorId: value.instructorId || undefined, locationId: value.locationId || undefined, serviceId: value.serviceId || undefined, q: value.q.trim() || undefined });

export function BookingsView({ data, onBooking, onNew }: Props) {
  const [draft, setDraft] = useState<Filters>(() => initial(data.business.timezone));
  const [filters, setFilters] = useState<Filters>(() => initial(data.business.timezone));
  const [bookings, setBookings] = useState<WorkspaceBooking[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const resultStatus = loading
    ? 'Loading bookings.'
    : loadingMore
      ? 'Loading more bookings.'
      : `${bookings.length} booking ${bookings.length === 1 ? 'result' : 'results'} loaded.`;

  const load = useCallback(async (value: Filters, cursor?: string) => {
    const current = ++generation.current;
    cursor ? setLoadingMore(true) : setLoading(true); setError('');
    try {
      const result = await loadBookings({ ...requestValues(value), ...(cursor ? { cursor } : {}), limit: 30 });
      if (current !== generation.current) return;
      setBookings(previous => cursor ? [...previous, ...result.bookings] : result.bookings);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'Bookings could not be loaded.');
      if (!cursor) { setBookings([]); setNextCursor(null); }
    } finally { if (current === generation.current) { setLoading(false); setLoadingMore(false); } }
  }, []);

  // Workspace mutations refresh the bounded shell snapshot. Treat that new
  // snapshot as an invalidation signal for this independently paginated list.
  useEffect(() => { void load(filters); return () => { generation.current += 1; }; }, [filters, load, data.bookings]);

  async function exportCsv() {
    if (!filters.from || !filters.to) { toast.error('Choose a start and end date before exporting.'); return; }
    setExporting(true);
    try {
      const result = await downloadBookingsCsv(requestValues(filters));
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click();
      URL.revokeObjectURL(url); toast.success('Booking export downloaded');
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'The export could not be downloaded.'); }
    finally { setExporting(false); }
  }

  return <section aria-labelledby="bookings-title">
    <div className="section-heading items-end"><div><p className="eyebrow mb-2">LESSON OPERATIONS</p><h1 id="bookings-title">Bookings</h1><p className="mt-2 text-xs text-[#59675c]">Find, review, and export lessons without loading your full history.</p></div><div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">{onNew && <Button onClick={onNew}><Plus size={14} />New booking</Button>}<Button variant="outline" disabled={exporting} onClick={() => void exportCsv()}>{exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}Export CSV</Button></div></div>
    <form role="search" onSubmit={event => { event.preventDefault(); setFilters({ ...draft, q: draft.q.trim() }); }} className="panel mb-5 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <label className="sm:col-span-2"><span className="text-xs font-medium">Search</span><span className="relative mt-1 block"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-stone-400" /><input className="!pl-9" value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} placeholder="Lesson, student, coach, location, or ID" /></span></label>
      <Field label="From date (inclusive)"><input type="date" value={draft.from} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></Field>
      <Field label="To date (inclusive)"><input type="date" min={draft.from || undefined} value={draft.to} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></Field>
      <Field label="Status"><select value={draft.status} onChange={event => setDraft(value => ({ ...value, status: event.target.value as Filters['status'] }))}><option value="">All statuses</option>{['CONFIRMED', 'PENDING', 'COMPLETED', 'CANCELLED'].map(status => <option key={status}>{status}</option>)}</select></Field>
      <Field label="Coach"><select value={draft.instructorId} onChange={event => setDraft(value => ({ ...value, instructorId: event.target.value }))}><option value="">All coaches</option>{data.instructors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="Location"><select value={draft.locationId} onChange={event => setDraft(value => ({ ...value, locationId: event.target.value }))}><option value="">All locations</option>{data.locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="Class"><select value={draft.serviceId} onChange={event => setDraft(value => ({ ...value, serviceId: event.target.value }))}><option value="">All classes</option>{data.services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" disabled={loading}>Apply filters</Button><Button type="button" variant="ghost" onClick={() => { const value = initial(data.business.timezone); setDraft(value); setFilters(value); }}><X size={14} />Clear</Button><select aria-label="Sort bookings" className="!ml-auto !w-auto !text-xs max-sm:!ml-0" value={draft.sort} onChange={event => setDraft(value => ({ ...value, sort: event.target.value as 'asc' | 'desc' }))}><option value="asc">Oldest first</option><option value="desc">Newest first</option></select></div>
    </form>
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{resultStatus}</p>
    <div aria-busy={loading || loadingMore}>{loading ? <Loading /> : error && !bookings.length ? <ErrorState message={error} retry={() => void load(filters)} /> : bookings.length ? <div className="grid gap-3">{bookings.map(booking => <BookingCard key={booking.id} booking={booking} timezone={data.business.timezone} onOpen={() => onBooking(booking.id)} />)}</div> : <div className="panel p-10 text-center text-xs text-stone-500">No bookings match these filters.</div>}</div>
    {error && bookings.length > 0 && <p role="alert" className="mt-4 text-center text-xs text-red-700">{error}</p>}
    {nextCursor && <div className="mt-5 text-center"><Button variant="outline" disabled={loadingMore} onClick={() => void load(filters, nextCursor)}>{loadingMore && <Loader2 size={14} className="animate-spin" />}Load more bookings</Button></div>}
  </section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label><span className="mb-1 block text-xs font-medium">{label}</span>{children}</label>; }
function Loading() { return <div className="panel grid min-h-48 place-items-center text-xs text-stone-500"><span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Loading bookings…</span></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="panel p-8 text-center"><p role="alert" className="text-xs text-red-700">{message}</p><Button className="mt-4" variant="outline" onClick={retry}>Try again</Button></div>; }
function StatusBadge({ status, coachAcceptance }: { status: string; coachAcceptance?: string }) {
  return <span className={`badge ${status.toLowerCase()}`}><span className={`h-1 w-1 rounded-full ${status === 'PENDING' ? 'bg-[#b19756]' : status === 'CANCELLED' ? 'bg-red-400' : 'bg-[#809a68]'}`} />{status === 'PENDING' ? coachAcceptance === 'PENDING' ? 'Awaiting coach' : 'Venue pending' : status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}
function BookingCard({ booking, timezone, onOpen }: { booking: WorkspaceBooking; timezone: string; onOpen: () => void }) {
  const participants = booking.participants.map(item => item.name).join(', ') || 'No participants';
  return <article className="panel grid min-w-0 gap-4 p-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-center sm:p-5"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={onOpen} aria-label={`Open booking details for ${booking.serviceName} with ${participants}`} className="rounded-sm text-left text-sm font-semibold text-[#294735] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">{booking.serviceName}</button><StatusBadge status={booking.status} coachAcceptance={booking.coachAcceptance} /></div><p className="mt-2 break-words text-xs text-stone-500">{participants}</p></div><dl className="grid min-w-0 grid-cols-2 gap-3 text-xs sm:grid-cols-1"><div><dt className="text-[10px] uppercase tracking-wide text-[#59675c]">When</dt><dd className="mt-1">{shortDate(booking.startAt, timezone)} · {time(booking.startAt, timezone)}–{time(booking.endAt, timezone)}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-[#59675c]">Place and coach</dt><dd className="mt-1 break-words">{booking.locationName} · {booking.instructorName}</dd></div></dl><Button variant="outline" size="sm" onClick={onOpen} aria-label={'Open ' + booking.serviceName + ' booking'}>View details</Button></article>;
}
