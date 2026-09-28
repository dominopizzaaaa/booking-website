'use client';
import { useEffect, useState } from 'react';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { CalendarDays, Check, Clock3, MapPin, Repeat2, ArrowRight, Loader2, ExternalLink, UserRound, AlertCircle, Undo2, X, CalendarClock, ShieldCheck, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiError, createBooking, createBookingSeries, loadSlots, mutate, proposeWorkspaceReschedule, respondToAssignment, respondToRescheduleRequest, reversePayment } from '@/lib/api';
import { isManagerWorkspace, type ManagerWorkspace, type Payment, type Slot, type WorkspaceResponse } from '@/lib/types';
import { addCalendarWeeks, coversWeeklyOccurrences, dateKey, money, shortDate, time } from '@/lib/utils';
import { bookingDetailCapabilities } from './booking-detail-permissions';

type NewBookingDialogProps = { data: WorkspaceResponse; open: boolean; onClose: () => void; refresh: () => Promise<void> };
type WorkspaceService = WorkspaceResponse['services'][number];

function bookingClassAvailable(
  candidate: WorkspaceService,
  isClubCoach: boolean,
  coachInstructorId: string | null,
  activeLocationIds: Set<string>,
  activeInstructorIds: Set<string>,
) {
  if (!candidate.active) return false;
  return candidate.locations.some(mapping => activeLocationIds.has(mapping.locationId) && (
    isClubCoach ? (
      candidate.type === 'PRIVATE'
      && !!coachInstructorId
      && activeInstructorIds.has(coachInstructorId)
      && mapping.instructorIds.includes(coachInstructorId)
    ) : mapping.instructorIds.some(instructorId => activeInstructorIds.has(instructorId))
  ));
}

function packageCoversClass(pkg: ManagerWorkspace['packages'][number], serviceId: string) {
  if (pkg.serviceIds?.length) return pkg.serviceIds.includes(serviceId);
  // A marketplace package with only rental scopes cannot pay for a class.
  // Legacy packages have no scope rows and retain their nullable serviceId rule.
  if (pkg.rentalLocationIds?.length) return false;
  return !pkg.serviceId || pkg.serviceId === serviceId;
}

function packageCoversBooking(
  pkg: ManagerWorkspace['packages'][number],
  serviceId: string,
  startAt: string,
  repeatWeeks: number,
  timezone: string,
) {
  if (!pkg.paid || !packageCoversClass(pkg, serviceId)) return false;
  if (pkg.totalCredits - pkg.usedCredits < repeatWeeks || !startAt) return false;
  return coversWeeklyOccurrences(pkg.expiresAt, startAt, repeatWeeks, timezone);
}

function packageCoversDates(
  pkg: ManagerWorkspace['packages'][number], serviceId: string, occurrenceStartAts: string[],
) {
  if (!pkg.paid || !packageCoversClass(pkg, serviceId)) return false;
  if (pkg.totalCredits - pkg.usedCredits < occurrenceStartAts.length || !occurrenceStartAts.length) return false;
  const expiry = new Date(pkg.expiresAt).getTime();
  return Number.isFinite(expiry) && occurrenceStartAts.every(startAt => new Date(startAt).getTime() <= expiry);
}

function occurrenceIso(date: string, selectedSlot: string, timezone: string) {
  if (!date || !selectedSlot) return '';
  const clock = formatInTimeZone(selectedSlot, timezone, 'HH:mm:ss');
  return fromZonedTime(`${date}T${clock}`, timezone).toISOString();
}

function lessonHasEnded(endAt: string, now: number) {
  const end = new Date(endAt).getTime();
  return Number.isFinite(end) && end <= now;
}

export function NewBookingDialog(props: NewBookingDialogProps) {
  // Workspace switching does not require a full browser reload. Remount the
  // state holder on both workspace and open-state changes so selections and
  // uncontrolled notes cannot leak into another business or a later booking.
  return <BusinessBookingDialog key={`${props.data.business.id}:${props.open ? 'open' : 'closed'}`} {...props} />;
}

function BusinessBookingDialog({ data, open, onClose, refresh }: NewBookingDialogProps) {
  const isClubCoach = data.user.accountType === 'COACH' && data.business.kind === 'CLUB';
  const coachInstructorId = isClubCoach ? data.user.instructorId : null;
  const managerData = isManagerWorkspace(data) ? data : null;
  const activeLocationIds = new Set(data.locations.filter(candidate => candidate.active).map(candidate => candidate.id));
  const activeInstructorIds = new Set(data.instructors.filter(candidate => candidate.active).map(candidate => candidate.id));
  const [serviceId, setService] = useState(data.services.find(candidate => bookingClassAvailable(candidate, isClubCoach, coachInstructorId, activeLocationIds, activeInstructorIds))?.id || '');
  const [locationId, setLocation] = useState('');
  const [instructorId, setInstructor] = useState('');
  const [date, setDate] = useState(dateKey());
  const [slot, setSlot] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [studentId, setStudent] = useState('');
  const [packageId, setPackage] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [bookingMode, setBookingMode] = useState<'ONE' | 'SERIES'>('ONE');
  const [seriesName, setSeriesName] = useState('');
  const [seriesInterval, setSeriesInterval] = useState(1);
  const [seriesCount, setSeriesCount] = useState(4);
  const [seriesOccurrences, setSeriesOccurrences] = useState<Array<{ id: string; date: string }>>([]);
  const [rosterStudentIds, setRosterStudentIds] = useState<string[]>([]);
  const [rosterPackageIds, setRosterPackageIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const availableServices = data.services.filter(candidate => bookingClassAvailable(candidate, isClubCoach, coachInstructorId, activeLocationIds, activeInstructorIds));
  const service = data.services.find(s => s.id === serviceId);
  const isSeries = bookingMode === 'SERIES' && !!managerData;
  const isGroupSeries = isSeries && service?.type === 'GROUP';
  const serviceLocations = service?.locations.filter(locationMapping =>
    activeLocationIds.has(locationMapping.locationId)
    && (isClubCoach
      ? !!coachInstructorId && activeInstructorIds.has(coachInstructorId) && locationMapping.instructorIds.includes(coachInstructorId)
      : locationMapping.instructorIds.some(candidate => activeInstructorIds.has(candidate))),
  ) || [];
  const mapping = serviceLocations.find(l => l.locationId === locationId);
  const location = data.locations.find(l => l.id === locationId);
  const bookingInstructorId = coachInstructorId || instructorId;
  const seriesDates = seriesOccurrences.map(occurrence => occurrence.date);
  const seriesOccurrenceStartAts = seriesDates.map(seriesDate => occurrenceIso(seriesDate, slot, data.business.timezone)).filter(Boolean);
  const eligiblePackages = managerData?.packages.filter(pkg =>
    pkg.studentId === studentId && (isSeries
      ? packageCoversDates(pkg, serviceId, seriesOccurrenceStartAts)
      : packageCoversBooking(pkg, serviceId, slot, repeat, data.business.timezone)),
  ) ?? [];
  const seriesStudentIds = isGroupSeries ? rosterStudentIds : studentId ? [studentId] : [];
  const firstLocationId = serviceLocations[0]?.locationId || '';
  const firstInstructorId = mapping?.instructorIds.find(candidate => activeInstructorIds.has(candidate)) || '';
  useEffect(() => {
    if (open && !data.services.some(s => s.id === serviceId && bookingClassAvailable(s, isClubCoach, coachInstructorId, activeLocationIds, activeInstructorIds))) {
      setService(data.services.find(s => bookingClassAvailable(s, isClubCoach, coachInstructorId, activeLocationIds, activeInstructorIds))?.id || '');
    }
  }, [open, data.services, data.locations, data.instructors, serviceId, coachInstructorId, isClubCoach]);
  useEffect(() => { setLocation(firstLocationId); }, [serviceId, firstLocationId]);
  useEffect(() => { if (!isClubCoach) setInstructor(firstInstructorId); }, [locationId, serviceId, firstInstructorId, isClubCoach]);
  useEffect(() => {
    if (packageId && !eligiblePackages.some(pkg => pkg.id === packageId)) setPackage('');
  }, [eligiblePackages, packageId]);
  useEffect(() => {
    if (!isSeries || !slot) { setSeriesOccurrences([]); return; }
    setSeriesOccurrences(Array.from({ length: seriesCount }, (_, index) => ({
      id: `${slot}:${seriesInterval}:${index}`,
      date: dateKey(addCalendarWeeks(slot, index * seriesInterval, data.business.timezone), data.business.timezone),
    })));
  }, [isSeries, slot, seriesCount, seriesInterval, data.business.timezone]);
  useEffect(() => {
    if (service?.type !== 'GROUP') setRosterStudentIds([]);
  }, [service?.type]);
  useEffect(() => {
    let active = true;
    setSlot(''); setSlots([]); setError(''); setSlotsError('');
    if (!open || !serviceId || !locationId || !bookingInstructorId || !date) return;
    setSlotsLoading(true);
    loadSlots(data.business.slug, { serviceId, locationId, instructorId: bookingInstructorId, date }).then(r => { if (active) setSlots(r.slots); }).catch(e => { if (active) setSlotsError(e.message); }).finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [open, serviceId, locationId, bookingInstructorId, date, data.business.slug]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!slot || (isSeries ? !seriesStudentIds.length : !studentId)) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      if (isSeries) {
        await createBookingSeries({
          serviceId, locationId, instructorId: bookingInstructorId, name: seriesName,
          occurrenceStartAts: seriesOccurrenceStartAts,
          participants: seriesStudentIds.map(id => ({
            studentId: id, ...((rosterPackageIds[id] || (!isGroupSeries && id === studentId ? packageId : ''))
              ? { packageId: rosterPackageIds[id] || packageId } : {}),
          })),
          notes: String(form.get('notes') || ''), address: String(form.get('address') || ''),
        });
      } else {
        await createBooking({ serviceId, locationId, ...(isClubCoach ? {} : { instructorId: bookingInstructorId }), startAt: slot, studentId, repeatWeeks: repeat, ...(packageId ? { packageId } : {}), notes: String(form.get('notes') || ''), address: String(form.get('address') || '') });
      }
      await refresh();
      toast.success(isSeries ? `${seriesOccurrenceStartAts.length} classes added to the series` : repeat > 1 ? `${repeat} weekly classes booked` : 'Booking added to your schedule');
      onClose();
    } catch (e) {
      const err = e as ApiError; const detail = err.details as { conflicts?: { date?: string; startAt?: string; reason: string }[] } | undefined;
      setError(detail?.conflicts?.length ? `${err.message} ${detail.conflicts.map(c => `${c.startAt ?? c.date}: ${c.reason}`).join('; ')}` : err.message);
    } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}><DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto"><DialogTitle className="text-xl font-semibold tracking-tight">Add a booking</DialogTitle><DialogDescription className="mt-2 mb-6 text-xs text-stone-500">Choose the class, venue, students, and time.</DialogDescription><form onSubmit={submit} className="form-stack">
    {managerData && <div className="tab-bar w-fit" role="group" aria-label="Booking type"><button type="button" aria-pressed={bookingMode === 'ONE'} className={bookingMode === 'ONE' ? 'active' : ''} onClick={() => setBookingMode('ONE')}>One class</button><button type="button" aria-pressed={bookingMode === 'SERIES'} className={bookingMode === 'SERIES' ? 'active' : ''} onClick={() => setBookingMode('SERIES')}>Series</button></div>}
    <div className="form-grid"><div className="field-wide"><label htmlFor="booking-service">{isClubCoach ? '1-1 session' : 'Class'}</label><select id="booking-service" value={serviceId} onChange={e => { setService(e.target.value); setPackage(''); setRosterStudentIds([]); setRosterPackageIds({}); }} required><option value="" disabled>Choose a class</option>{availableServices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>{isClubCoach && <div className="field-wide grid gap-3 rounded-xl border border-[#e3e8df] bg-[#f7f9f4] p-3 sm:grid-cols-2" role="group" aria-label="1-1 session details"><p className="text-[11px] text-stone-500"><span className="block text-[10px] font-semibold uppercase tracking-wide text-stone-400">Club</span><strong className="mt-1 block font-semibold text-[#344b39]">{data.business.name}</strong></p><p className="text-[11px] text-stone-500"><span className="block text-[10px] font-semibold uppercase tracking-wide text-stone-400">Duration</span><strong className="mt-1 block font-semibold text-[#344b39]">{mapping?.duration || service?.duration || 60} minutes</strong></p></div>}<div><label htmlFor="booking-location">Location</label><select id="booking-location" value={locationId} onChange={e => setLocation(e.target.value)} required><option value="" disabled>Select location</option>{serviceLocations.map(l => <option key={l.locationId} value={l.locationId}>{data.locations.find(x => x.id === l.locationId)?.name}</option>)}</select></div>{!isClubCoach && <div><label htmlFor="booking-instructor">Instructor</label><select id="booking-instructor" value={instructorId} onChange={e => setInstructor(e.target.value)} required><option value="" disabled>Select instructor</option>{data.instructors.filter(i => activeInstructorIds.has(i.id) && mapping?.instructorIds.includes(i.id)).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>}<div><label htmlFor="booking-date">First date</label><input id="booking-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} required /></div>{isSeries ? <><div><label htmlFor="series-interval">Repeat every</label><select id="series-interval" value={seriesInterval} onChange={e => setSeriesInterval(Number(e.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} week{value === 1 ? '' : 's'}</option>)}</select></div><div><label htmlFor="series-count">Number of classes</label><input id="series-count" type="number" min={2} max={24} value={seriesCount} onChange={e => setSeriesCount(Math.min(24, Math.max(2, Number(e.target.value) || 2)))} /></div><div><label htmlFor="series-name">Series name (optional)</label><input id="series-name" value={seriesName} maxLength={120} onChange={e => setSeriesName(e.target.value)} placeholder="Tuesday beginners" /></div></> : <div><label htmlFor="booking-repeat">Repeat</label><select id="booking-repeat" value={repeat} onChange={e => setRepeat(Number(e.target.value))}><option value={1}>Does not repeat</option><option value={4}>Weekly · 4 classes</option><option value={8}>Weekly · 8 classes</option><option value={10}>Weekly · 10 classes</option></select></div>}</div>
    <div aria-busy={slotsLoading}><label id="booking-times-label">Available start times · {mapping?.duration || service?.duration || 60} min</label><p role="status" aria-live="polite" className="sr-only">{slotsLoading ? 'Checking availability.' : slotsError ? 'Available times could not be loaded.' : slots.filter(s => s.available).length === 1 ? '1 available time loaded.' : slots.filter(s => s.available).length + ' available times loaded.'}</p>{slotsLoading ? <p className="flex items-center gap-2 py-4 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking all locations and travel time…</p> : slotsError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{slotsError}</p> : <div role="radiogroup" aria-labelledby="booking-times-label" className="grid grid-cols-4 gap-2">{slots.filter(s => s.available).map(s => <button type="button" role="radio" aria-checked={slot === s.startAt} key={s.startAt} onClick={() => setSlot(s.startAt)} className={`rounded-lg border px-2 py-2.5 text-sm ${slot === s.startAt ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-stone-200 hover:bg-stone-50'}`}>{time(s.startAt)}</button>)}{!slots.some(s => s.available) && <p className="col-span-4 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">No available times. Try a different date, {isClubCoach ? 'class' : 'instructor'}, or location.</p>}</div>}</div>
    {isSeries && <div><div className="mb-2 flex flex-wrap items-center justify-between gap-3"><label>Series dates</label><span className="text-[10px] text-stone-500">{seriesDates.length} of 24</span></div><div className="space-y-2">{seriesOccurrences.map((occurrence, index) => <div key={occurrence.id} className="flex flex-wrap items-center gap-2"><input className="min-w-0 flex-1" aria-label={`Class ${index + 1} date`} type="date" min={dateKey()} value={occurrence.date} onChange={e => setSeriesOccurrences(current => current.map(item => item.id === occurrence.id ? { ...item, date: e.target.value } : item))} /><Button type="button" variant="ghost" size="icon" aria-label={`Remove class ${index + 1}`} disabled={seriesDates.length <= 2} onClick={() => setSeriesOccurrences(current => current.filter(item => item.id !== occurrence.id))}><X size={14} /></Button></div>)}</div><p className="mt-2 text-[10px] text-stone-400">Edit or remove individual dates for holidays and other exceptions.</p></div>}
    {isGroupSeries ? <fieldset><legend className="mb-2 text-xs font-medium">Group roster · {rosterStudentIds.length}/{service?.capacity ?? 0}</legend><div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-stone-200 p-2">{data.students.filter(student => !!student.userId).map(student => {
      const selected = rosterStudentIds.includes(student.id);
      const eligible = managerData?.packages.filter(pkg => pkg.studentId === student.id && packageCoversDates(pkg, serviceId, seriesOccurrenceStartAts)) ?? [];
      const atCapacity = rosterStudentIds.length >= (service?.capacity ?? 0);
      return <div key={student.id} className="rounded-md border border-stone-100 p-2"><label className="flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" checked={selected} disabled={!selected && atCapacity} onChange={e => {
        setRosterStudentIds(current => e.target.checked ? [...current, student.id] : current.filter(id => id !== student.id));
        if (!e.target.checked) setRosterPackageIds(current => { const next = { ...current }; delete next[student.id]; return next; });
      }} /><span><strong className="block font-medium text-stone-700">{student.name}</strong><span className="text-[10px] text-stone-400">{student.email}</span></span></label>{selected && <select aria-label={`Package for ${student.name}`} className="mt-2" value={rosterPackageIds[student.id] ?? ''} onChange={e => setRosterPackageIds(current => ({ ...current, [student.id]: e.target.value }))}><option value="">Pay per class</option>{eligible.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name} · {pkg.totalCredits - pkg.usedCredits} credits left</option>)}</select>}</div>;
    })}{!data.students.some(student => !!student.userId) && <p className="p-2 text-xs text-stone-500">No registered students are available.</p>}</div>{rosterStudentIds.length >= (service?.capacity ?? 0) && <p className="mt-2 text-[10px] text-amber-700">This group roster is at capacity.</p>}</fieldset> : <div><label htmlFor="booking-student">Registered student</label><select id="booking-student" value={studentId} onChange={e => { setStudent(e.target.value); setPackage(''); }} required><option value="" disabled>Select a student account</option>{data.students.filter(student => !!student.userId).map(student => <option key={student.id} value={student.id}>{student.name} · {student.email}</option>)}</select></div>}
    {managerData && !isGroupSeries && eligiblePackages.length > 0 && <div><label htmlFor="booking-package">Package credits</label><select id="booking-package" value={packageId} onChange={e => setPackage(e.target.value)}><option value="">Pay per class</option>{eligiblePackages.map(p => <option key={p.id} value={p.id}>{p.name} · {p.totalCredits - p.usedCredits} credits left</option>)}</select></div>}
    {location?.type === 'HOME' && <div><label htmlFor="booking-address">Student address</label><input id="booking-address" name="address" required placeholder="Full address and unit number" /></div>}
    <div><label htmlFor="booking-notes">Internal class notes (optional)</label><textarea id="booking-notes" name="notes" rows={2} placeholder="Preparation, progress, or private provider notes" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team, never on the student booking page.</p></div>
    {location?.requiresApproval && <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800"><AlertCircle size={17} className="shrink-0" />This class will be pending venue confirmation. Scheduling does not reserve an external court or room.</div>}
    {(isSeries || repeat > 1) && <p className="text-xs text-stone-500">All {isSeries ? seriesDates.length : repeat} occurrences and every selected student must be available. If anything conflicts, no classes or package credits will be booked.</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
    <div className="flex flex-col items-stretch justify-between gap-4 border-t border-stone-100 pt-5 sm:flex-row sm:items-center"><div>{managerData ? <ManagerBookingPrice data={managerData} serviceId={serviceId} locationId={locationId} packageId={packageId} repeat={isSeries ? seriesDates.length * Math.max(1, seriesStudentIds.length) : repeat} /> : <p className="text-[11px] leading-relaxed text-stone-500">{repeat} class{repeat > 1 ? 'es' : ''} · payment details stay with the club.</p>}</div><Button type="submit" disabled={busy || !slot || (isSeries ? seriesDates.length < 2 || !seriesStudentIds.length : !studentId)}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{isSeries ? 'Create series' : 'Add booking'}</Button></div>
  </form></DialogContent></Dialog>;
}

function ManagerBookingPrice({ data, serviceId, locationId, packageId, repeat }: { data: ManagerWorkspace; serviceId: string; locationId: string; packageId: string; repeat: number }) {
  const service = data.services.find(item => item.id === serviceId);
  const mapping = service?.locations.find(item => item.locationId === locationId);
  return <p className="text-lg font-semibold">{packageId ? `${repeat} package credit${repeat > 1 ? 's' : ''}` : money((mapping?.price ?? service?.price ?? 0) * repeat)}</p>;
}

/**
 * One booking, and every decision attached to it.
 *
 * Three things changed shape here. A lesson the club assigned to a coach waits
 * on that coach's acceptance. A time change is proposed and answered rather
 * than applied. And a recorded payment can be taken back, because recording
 * one is a human action and humans mistype.
 */
export function BookingDetail({ bookingId, data, onClose, refresh, onOpenChat }: { bookingId: string | null; data: WorkspaceResponse; onClose: () => void; refresh: () => Promise<void>; onOpenChat?: (bookingId: string) => void }) {
  const managerData = isManagerWorkspace(data) ? data : null;
  const { mode, canManageBookings, canViewPayments, canRecordPayments, canReversePayments } = bookingDetailCapabilities(data);
  const [busy, setBusy] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [date, setDate] = useState(dateKey());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [proposalMessage, setProposalMessage] = useState('');
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const [confirmation, setConfirmation] = useState<{ kind: 'decline' | 'cancel' | 'reverse'; paymentId?: string } | null>(null);
  const [reversalReason, setReversalReason] = useState('Recorded by mistake');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const current = data.bookings.find(booking => booking.id === bookingId) ?? null;
  const managerBooking = canViewPayments
    ? managerData?.bookings.find(booking => booking.id === bookingId) ?? null
    : null;
  const currentStatus = current?.status;
  const currentEndAt = current?.endAt;
  useEffect(() => { setReschedule(false); setSelectedSlot(''); setProposalMessage(''); setConfirmation(null); setReversalReason('Recorded by mistake'); setNowMs(Date.now()); }, [bookingId]);
  useEffect(() => {
    if (!bookingId || !currentEndAt || currentStatus === 'CANCELLED' || currentStatus === 'COMPLETED') return;
    const end = new Date(currentEndAt).getTime();
    let timer: number | undefined;
    function updateClock() {
      const liveNow = Date.now();
      setNowMs(liveNow);
      if (Number.isFinite(end) && end > liveNow) {
        timer = window.setTimeout(updateClock, Math.max(50, Math.min(30_000, end - liveNow)));
      }
    }
    if (Number.isFinite(end) && end > Date.now()) {
      timer = window.setTimeout(updateClock, Math.max(50, Math.min(30_000, end - Date.now())));
    }
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        if (timer !== undefined) window.clearTimeout(timer);
        updateClock();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [bookingId, currentEndAt, currentStatus]);
  useEffect(() => {
    if (!currentEndAt || !lessonHasEnded(currentEndAt, nowMs)) return;
    setReschedule(false);
    setSelectedSlot('');
  }, [currentEndAt, nowMs]);
  useEffect(() => { let active = true; if (canManageBookings && reschedule && current) { setSlots([]); setSelectedSlot(''); setSlotsError(''); setSlotsLoading(true); loadSlots(data.business.slug, { serviceId: current.serviceId, instructorId: current.instructorId, locationId: current.locationId, date }).then(r => { if (active) setSlots(r.slots); }).catch(e => { if (active) setSlotsError(e.message); }).finally(() => { if (active) setSlotsLoading(false); }); } return () => { active = false; }; }, [canManageBookings, reschedule, date, bookingId, current, data.business.slug]);
  if (!current) return null;
  const endAt = current.endAt;

  async function run<T>(work: () => Promise<T>, success: string) {
    setBusy(true);
    try { await work(); await refresh(); toast.success(success); return true; }
    catch (e) { toast.error((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function action(path: string, values: unknown, method: 'PATCH' | 'POST' = 'PATCH') {
    return run(() => mutate(path, method, values), 'Booking updated');
  }
  function allowBeforeLessonEnd() {
    const liveNow = Date.now();
    if (!lessonHasEnded(endAt, liveNow)) return true;
    setNowMs(liveNow);
    setReschedule(false);
    return false;
  }
  function allowAfterLessonEnd() {
    const liveNow = Date.now();
    if (lessonHasEnded(endAt, liveNow)) return true;
    setNowMs(liveNow);
    return false;
  }

  const inactive = current.status === 'CANCELLED';
  const hasEnded = lessonHasEnded(current.endAt, nowMs);
  const canMarkCompleted = canManageBookings && current.status === 'CONFIRMED' && hasEnded;
  const canMarkAttendance = canManageBookings && hasEnded
    && ['CONFIRMED', 'COMPLETED'].includes(current.status)
    && current.coachAcceptance !== 'PENDING';
  const scheduleClosed = inactive || current.status === 'COMPLETED' || hasEnded;
  const awaitingCoach = current.status === 'PENDING' && current.coachAcceptance === 'PENDING';
  const isAssignedCoach = mode === 'COACH' && data.user.accountType === 'COACH' && data.user.instructorId === current.instructorId;
  // Accepting an assignment is a teaching decision. The club account manages
  // the roster but never answers on a coach's behalf.
  const canAnswerAssignment = awaitingCoach && isAssignedCoach && !hasEnded;
  const canOpenSessionChat = data.user.accountType === 'CLUB' || isAssignedCoach;
  const openRequest = data.rescheduleRequests.find(request => request.bookingId === current.id && request.status === 'PENDING');
  const requestRaisedByStudent = openRequest?.requestedByRole === 'STUDENT';
  // Provider roles share a workspace, but they do not share ownership of a
  // proposal: the API only lets the exact role that raised it withdraw it.
  const requesterRole = mode === 'COACH' ? 'COACH' : 'CLUB';
  const canWithdrawRequest = canManageBookings
    && openRequest?.requestedByRole === requesterRole
    && openRequest.requestedByUserId === data.user.id;
  const requestOwner = openRequest?.requestedByRole === 'CLUB' ? 'club' : 'coach';
  const requestHeading = scheduleClosed
    ? 'Reschedule request needs closing'
    : requestRaisedByStudent
      ? 'The student asked for a new time'
      : canWithdrawRequest
        ? 'Waiting for the student to reply'
        : `The ${requestOwner} proposed a new time`;
  const requestStatusMessage = scheduleClosed
    ? `${hasEnded ? 'The original class has ended' : 'The class is closed'}, so this proposal can no longer be accepted. ${requestRaisedByStudent
      ? canManageBookings ? 'Decline the request to close it.' : 'A booking manager can decline the request to close it.'
      : canWithdrawRequest
        ? 'Withdraw the request to close it.'
        : `Only the ${requestOwner} account that raised it can withdraw the request.`}`
    : !requestRaisedByStudent && !canWithdrawRequest
      ? `The class keeps its current time until the student replies. Only the ${requestOwner} account that raised it can withdraw the request.`
      : 'The class keeps its current time until both sides agree.';
  // Payments for this lesson that still count, plus the reversed ones kept for
  // the audit trail.
  const lessonPayments = canViewPayments && managerData
    ? managerData.payments.filter(payment => payment.bookingId === current.id && payment.kind !== 'CLUB_TO_COACH')
    : [];
  const activePaymentFor = (studentId: string): Payment | undefined =>
    lessonPayments.find(payment => payment.studentId === studentId && !payment.reversedAt);

  return <Dialog open={!!bookingId} onOpenChange={v => { if (!v && !busy) onClose(); }}><DialogContent className="max-w-lg [&_.text-stone-400]:!text-[#59675c]"><DialogTitle className="pr-7 text-xl font-semibold">{current.serviceName}</DialogTitle><DialogDescription className="mt-2 mb-5 text-xs text-stone-500">Booking details · {current.id.slice(-8).toUpperCase()}</DialogDescription>
    <div className="flex flex-wrap items-center gap-2">
      <span className={`badge ${current.status.toLowerCase()}`}>{current.status === 'PENDING' ? awaitingCoach ? 'Awaiting coach' : 'Venue pending' : current.status.toLowerCase()}</span>
      {current.recurringId && <span className="badge"><Repeat2 size={11} />Weekly class</span>}
      {managerBooking && <span className="badge">{managerBooking.paymentRoute === 'CLUB' ? 'Paid through the club' : 'Paid to the coach'}</span>}
      {onOpenChat && canOpenSessionChat && current.paymentRoute === 'CLUB' && <Button size="sm" variant="outline" className="ml-auto" onClick={() => onOpenChat(current.id)}><MessageCircle size={13} aria-hidden="true" />Message</Button>}
    </div>
    <div className="my-5 space-y-3 rounded-xl bg-[#f5f7f1] p-4 text-xs"><p className="flex items-center gap-3"><CalendarDays size={15} className="text-stone-400" />{shortDate(current.startAt)}<span className="ml-auto">{time(current.startAt)} – {time(current.endAt)}</span></p><p className="flex items-center gap-3"><MapPin size={15} className="text-stone-400" />{current.locationName}</p><p className="flex items-center gap-3"><UserRound size={15} className="text-stone-400" />{current.instructorName}</p>{current.address && <p className="pl-7">{current.address}</p>}</div>

    {awaitingCoach && <div className="mb-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
      <p className="leading-relaxed">{current.createdByRole === 'CLUB' ? 'The club assigned this class. The student does not need to accept it, but the coach does before it is confirmed.' : 'This class is waiting for the coach to accept it.'}</p>
      {canAnswerAssignment && <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => { if (allowBeforeLessonEnd()) void run(() => respondToAssignment(current.id, 'accept'), 'Class accepted'); }}><Check size={13} />Accept class</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (allowBeforeLessonEnd()) setConfirmation({ kind: 'decline' }); }}><X size={13} />Cannot teach this</Button>
      </div>}
    </div>}

    {current.status === 'PENDING' && !awaitingCoach && <div className="mb-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800"><p className="leading-relaxed">{managerData && canManageBookings ? 'Please secure the venue separately, then confirm this class. Courtly has not reserved the court.' : 'Venue confirmation is still pending. The club can confirm it once the court or room is secured.'}</p>{managerData && canManageBookings && !hasEnded && <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={() => { if (allowBeforeLessonEnd()) void action(`/bookings/${current.id}`, { status: 'CONFIRMED' }); }}><Check size={13} />Venue secured · confirm</Button>}</div>}

    {openRequest && <div role="region" aria-label="Pending reschedule request" className="mb-5 rounded-lg border border-[#e7dcc1] bg-[#fcf8ee] p-3 text-xs text-[#7a6838]">
      <p className="flex items-center gap-2 font-semibold"><CalendarClock size={14} />{requestHeading}</p>
      <p className="mt-2 leading-relaxed">Proposed: <strong className="font-semibold">{shortDate(openRequest.proposedStartAt)} at {time(openRequest.proposedStartAt)}</strong>. {requestStatusMessage}</p>
      {openRequest.message && <p className="mt-2 border-l-2 border-[#e0d3b4] pl-3 italic">“{openRequest.message}”</p>}
      {canManageBookings && (canWithdrawRequest || requestRaisedByStudent) && <div className="mt-3 flex flex-wrap gap-2">
        {canWithdrawRequest
          ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => respondToRescheduleRequest(openRequest.id, 'withdraw'), 'Request withdrawn')}><X size={13} />Withdraw request</Button>
          : requestRaisedByStudent ? <>
            {!scheduleClosed && <Button size="sm" disabled={busy} onClick={() => { if (allowBeforeLessonEnd()) void run(() => respondToRescheduleRequest(openRequest.id, 'accept'), 'New time confirmed'); }}><Check size={13} />Accept new time</Button>}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => respondToRescheduleRequest(openRequest.id, 'decline'), 'Request declined')}><X size={13} />Decline</Button>
          </> : null}
      </div>}
    </div>}

    <h3 className="mb-3 text-xs">Participants · {current.participants.length}/{current.capacity}</h3>
    <div className="space-y-3">{current.participants.map(p => {
      const managerParticipant = managerBooking?.participants.find(participant => participant.id === p.id);
      const payment = activePaymentFor(p.studentId);
      return <div className="rounded-lg border border-stone-200 p-3" key={p.id}>
        <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-semibold">{p.name}</p><p className="mt-1 text-[10px] text-stone-400">{p.email}</p></div>{managerParticipant && <span className={`badge ${!managerParticipant.paid ? 'pending' : ''}`}>{managerParticipant.packageId ? 'Package credit' : managerParticipant.paid ? 'Paid' : `${money(managerParticipant.price)} unpaid`}</span>}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {canMarkAttendance && <><Button size="sm" variant={p.attendance === 'PRESENT' ? 'default' : 'outline'} disabled={busy} onClick={() => { if (allowAfterLessonEnd()) void action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'PRESENT' }); }}><Check size={12} />Attended</Button><Button size="sm" variant={p.attendance === 'ABSENT' ? 'destructive' : 'ghost'} disabled={busy} onClick={() => { if (allowAfterLessonEnd()) void action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'ABSENT' }); }}>No-show</Button></>}
          {canRecordPayments && managerParticipant && !managerParticipant.paid && !managerParticipant.packageId && !inactive && <Button size="sm" variant="outline" disabled={busy} onClick={() => action('/payments', { studentId: p.studentId, bookingId: current.id, amount: managerParticipant.price, method: payMethod, note: 'Class payment' }, 'POST')}>Record payment</Button>}
          {/* Recording a payment is undoable: the row stays in the ledger,
              marked reversed, and the participant returns to unpaid. */}
          {canReversePayments && managerParticipant && payment && !managerParticipant.packageId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setReversalReason('Recorded by mistake'); setConfirmation({ kind: 'reverse', paymentId: payment.id }); }}><Undo2 size={12} />Undo payment</Button>}
        </div>
        {managerParticipant && payment && <p className="mt-2 text-[10px] text-stone-400">{money(payment.amount)} recorded {shortDate(payment.paidAt)} · {payment.method.replace('_', ' ').toLowerCase()}</p>}
        {managerParticipant && lessonPayments.some(candidate => candidate.studentId === p.studentId && candidate.reversedAt) && <p className="mt-1 text-[10px] text-stone-400">{lessonPayments.filter(candidate => candidate.studentId === p.studentId && candidate.reversedAt).length} reversed payment(s) kept in the ledger.</p>}
      </div>;
    })}</div>

    {canRecordPayments && managerBooking && managerBooking.participants.some(p => !p.paid && !p.packageId) && !inactive && <div className="mt-4"><label htmlFor="detail-payment-method">Payment recording method</label><select id="detail-payment-method" value={payMethod} onChange={e => setPayMethod(e.target.value)}><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select>{managerBooking.paymentRoute === 'CLUB' && <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-stone-500"><ShieldCheck size={12} className="mt-0.5 shrink-0" />This class runs through the club. Record what the student paid the club here, then record the coach&rsquo;s payout under Payments.</p>}</div>}

    {confirmation && (confirmation.kind === 'decline' ? canAnswerAssignment : confirmation.kind === 'cancel' ? canManageBookings : canReversePayments) && <section role="region" aria-labelledby="booking-confirmation-heading" className="mt-5 rounded-xl border border-[#e5c8be] bg-[#fff7f3] p-4">
      <h3 id="booking-confirmation-heading" className="text-base font-semibold text-[#5f3025]">{confirmation.kind === 'decline' ? 'Decline this class?' : confirmation.kind === 'cancel' ? 'Cancel this class?' : 'Reverse this payment?'}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[#704c42]">{confirmation.kind === 'decline' ? 'The slot will be released, any package credit returned, and the club asked to reassign it.' : confirmation.kind === 'cancel' ? 'This cancels the class for every participant and returns package credits. Other recurring classes stay unchanged.' : 'The payment stays in the ledger for the audit trail, but it will no longer count toward the balance.'}</p>
      {confirmation.kind === 'reverse' && <div className="mt-4"><label htmlFor="booking-reversal-reason" className="text-sm font-medium text-[#5f3025]">Reason for reversal</label><textarea autoFocus id="booking-reversal-reason" rows={2} value={reversalReason} onChange={event => setReversalReason(event.target.value)} className="mt-2" /></div>}
      <div className="mt-4 flex flex-wrap gap-2"><Button autoFocus={confirmation.kind !== 'reverse'} type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Keep as is</Button><Button type="button" variant="destructive" disabled={busy || (confirmation.kind === 'reverse' && !reversalReason.trim())} onClick={() => { void (async () => { if (confirmation.kind !== 'reverse' && !allowBeforeLessonEnd()) return; const succeeded = confirmation.kind === 'decline' ? await run(() => respondToAssignment(current.id, 'decline'), 'Class declined') : confirmation.kind === 'cancel' ? await action(`/bookings/${current.id}`, { status: 'CANCELLED' }) : confirmation.paymentId ? await run(() => reversePayment(confirmation.paymentId!, reversalReason.trim()), 'Payment reversed') : false; if (succeeded) setConfirmation(null); })(); }}>{busy && <Loader2 size={14} className="animate-spin" />}{confirmation.kind === 'decline' ? 'Decline class' : confirmation.kind === 'cancel' ? 'Cancel class' : 'Reverse payment'}</Button></div>
    </section>}

    <form className="mt-5" onSubmit={event => { event.preventDefault(); if (!canManageBookings) return; const form = new FormData(event.currentTarget); void action(`/bookings/${current.id}`, { notes: String(form.get('notes') || '') }); }}><label htmlFor="detail-notes">Internal class notes</label><textarea key={current.id} id="detail-notes" name="notes" rows={3} maxLength={2000} defaultValue={current.notes} readOnly={!canManageBookings} placeholder="Goals, progress, and details for your team" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team. Student-submitted context is kept with that participant.</p>{canManageBookings && <Button className="mt-2" type="submit" size="sm" variant="outline" disabled={busy}>Save notes</Button>}</form>

    {canManageBookings && reschedule && !scheduleClosed && <div className="mt-5 space-y-3 rounded-lg bg-stone-50 p-3">
      <label htmlFor="reschedule-date">Propose a new time</label>
      <input id="reschedule-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} />
      <div aria-busy={slotsLoading}><p role="status" aria-live="polite" className="sr-only">{slotsLoading ? 'Checking availability.' : slotsError ? 'Available times could not be loaded.' : slots.filter(s => s.available && s.startAt !== current.startAt).length + ' available times loaded.'}</p>{slotsLoading ? <p className="flex items-center gap-2 py-3 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking availability…</p> : slotsError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{slotsError}</p> : <select aria-label="New class time" value={selectedSlot} onChange={e => setSelectedSlot(e.target.value)}><option value="">Select available time</option>{slots.filter(s => s.available && s.startAt !== current.startAt).map(s => <option key={s.startAt} value={s.startAt}>{time(s.startAt)}</option>)}</select>}</div>
      <div><label htmlFor="reschedule-message">Message to the student <span className="font-normal text-stone-400">(optional)</span></label><input id="reschedule-message" value={proposalMessage} maxLength={500} onChange={e => setProposalMessage(e.target.value)} placeholder="Why the time needs to move" /></div>
      <p className="text-[10px] leading-relaxed text-stone-500">The student has to accept before the session moves. This affects only the selected class, not the full series.</p>
      <Button size="sm" disabled={busy || !selectedSlot} onClick={() => { if (allowBeforeLessonEnd()) void run(async () => { await proposeWorkspaceReschedule(current.id, selectedSlot, proposalMessage); setReschedule(false); }, 'Request sent to the student'); }}>Send request<ArrowRight size={13} /></Button>
    </div>}

    {canManageBookings && (canMarkCompleted || !scheduleClosed) && <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-stone-100 pt-4">
      {canMarkCompleted
        ? <Button size="sm" disabled={busy} onClick={() => { if (allowAfterLessonEnd()) void run(() => mutate(`/bookings/${current.id}`, 'PATCH', { status: 'COMPLETED' }), 'Class marked completed'); }}><Check size={13} />Mark completed</Button>
        : <Button variant="outline" size="sm" disabled={!!openRequest || awaitingCoach} onClick={() => { if (allowBeforeLessonEnd()) setReschedule(v => !v); }}><Clock3 size={13} />{openRequest ? 'Reschedule pending' : 'Propose a new time'}</Button>}
      {!scheduleClosed && <Button variant="destructive" size="sm" disabled={busy} onClick={() => { if (allowBeforeLessonEnd()) setConfirmation({ kind: 'cancel' }); }}>Cancel class</Button>}
    </div>}
  </DialogContent></Dialog>;
}
