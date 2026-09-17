'use client';
import { useEffect, useState } from 'react';
import { CalendarDays, Check, Clock3, MapPin, Repeat2, ArrowRight, Loader2, ExternalLink, UserRound, AlertCircle, Undo2, X, CalendarClock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiError, createBooking, loadSlots, mutate, proposeWorkspaceReschedule, respondToAssignment, respondToRescheduleRequest, reversePayment } from '@/lib/api';
import { isManagerWorkspace, type ManagerWorkspace, type Payment, type Slot, type WorkspaceResponse } from '@/lib/types';
import { dateKey, money, shortDate, time } from '@/lib/utils';

type NewBookingDialogProps = { data: WorkspaceResponse; open: boolean; onClose: () => void; refresh: () => Promise<void> };

export function NewBookingDialog(props: NewBookingDialogProps) {
  // Workspace switching does not require a full browser reload. Remount the
  // state holder so selections and uncontrolled notes from one business can
  // never leak into the next business's booking form.
  return <BusinessBookingDialog key={props.data.business.id} {...props} />;
}

function BusinessBookingDialog({ data, open, onClose, refresh }: NewBookingDialogProps) {
  const managerData = isManagerWorkspace(data) ? data : null;
  const [serviceId, setService] = useState(data.services.find(s => s.active)?.id || '');
  const [locationId, setLocation] = useState('');
  const [instructorId, setInstructor] = useState('');
  const [date, setDate] = useState(dateKey());
  const [slot, setSlot] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [studentId, setStudent] = useState('');
  const [packageId, setPackage] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const service = data.services.find(s => s.id === serviceId);
  const mapping = service?.locations.find(l => l.locationId === locationId);
  const location = data.locations.find(l => l.id === locationId);
  useEffect(() => { if (open && !data.services.some(s => s.id === serviceId && s.active)) setService(data.services.find(s => s.active)?.id || ''); }, [open, data.services, serviceId]);
  useEffect(() => { setLocation(service?.locations[0]?.locationId || ''); }, [serviceId]);
  useEffect(() => { setInstructor(mapping?.instructorIds[0] || ''); }, [locationId, serviceId]);
  useEffect(() => {
    let active = true;
    setSlot(''); setSlots([]); setError('');
    if (!open || !serviceId || !locationId || !instructorId || !date) return;
    setSlotsLoading(true);
    loadSlots(data.business.slug, { serviceId, locationId, instructorId, date }).then(r => { if (active) setSlots(r.slots); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [open, serviceId, locationId, instructorId, date, data.business.slug]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!slot || !studentId) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      await createBooking({ serviceId, locationId, instructorId, startAt: slot, studentId, repeatWeeks: repeat, ...(packageId ? { packageId } : {}), notes: String(form.get('notes') || ''), address: String(form.get('address') || '') });
      await refresh(); toast.success(repeat > 1 ? `${repeat} weekly lessons booked` : 'Booking added to your schedule'); onClose();
    } catch (e) {
      const err = e as ApiError; const detail = err.details as { conflicts?: { date: string; reason: string }[] } | undefined;
      setError(detail?.conflicts?.length ? `${err.message} ${detail.conflicts.map(c => `${c.date}: ${c.reason}`).join('; ')}` : err.message);
    } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}><DialogContent className="max-w-xl"><DialogTitle className="text-xl font-semibold tracking-tight">Add a booking</DialogTitle><DialogDescription className="mt-2 mb-6 text-xs text-stone-500">A quick booking for the lessons arranged off the court.</DialogDescription><form onSubmit={submit} className="form-stack">
    <div className="form-grid"><div className="field-wide"><label htmlFor="booking-service">Service</label><select id="booking-service" value={serviceId} onChange={e => setService(e.target.value)} required><option value="" disabled>Choose a service</option>{data.services.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div><div><label htmlFor="booking-location">Location</label><select id="booking-location" value={locationId} onChange={e => setLocation(e.target.value)} required><option value="" disabled>Select location</option>{service?.locations.map(l => <option key={l.locationId} value={l.locationId}>{data.locations.find(x => x.id === l.locationId)?.name}</option>)}</select></div><div><label htmlFor="booking-instructor">Instructor</label><select id="booking-instructor" value={instructorId} onChange={e => setInstructor(e.target.value)} required><option value="" disabled>Select instructor</option>{data.instructors.filter(i => mapping?.instructorIds.includes(i.id)).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div><div><label htmlFor="booking-date">Date</label><input id="booking-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} required /></div><div><label htmlFor="booking-repeat">Repeat</label><select id="booking-repeat" value={repeat} onChange={e => setRepeat(Number(e.target.value))}><option value={1}>Does not repeat</option><option value={4}>Weekly · 4 lessons</option><option value={8}>Weekly · 8 lessons</option><option value={10}>Weekly · 10 lessons</option></select></div></div>
    <div><label>Available start times · {mapping?.duration || service?.duration || 60} min</label>{slotsLoading ? <p className="flex items-center gap-2 py-4 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking all locations and travel time…</p> : <div className="grid grid-cols-4 gap-2">{slots.filter(s => s.available).map(s => <button type="button" key={s.startAt} onClick={() => setSlot(s.startAt)} className={`rounded-lg border px-2 py-2.5 text-[11px] ${slot === s.startAt ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-stone-200 hover:bg-stone-50'}`}>{time(s.startAt)}</button>)}{!slots.some(s => s.available) && <p className="col-span-4 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">No available times. Try a different date, instructor, or location.</p>}</div>}</div>
    <div><label htmlFor="booking-student">Registered student</label><select id="booking-student" value={studentId} onChange={e => { setStudent(e.target.value); setPackage(''); }} required><option value="" disabled>Select a student account</option>{data.students.filter(student => !!student.userId).map(student => <option key={student.id} value={student.id}>{student.name} · {student.email}</option>)}</select><p className="mt-1 text-[10px] leading-relaxed text-stone-400">Bookings can only be created for students already linked to a Courtly student account. Add them from Students first if they are missing.</p></div>
    {managerData && studentId && managerData.packages.some(p => p.studentId === studentId && p.usedCredits < p.totalCredits) && <div><label htmlFor="booking-package">Lesson package</label><select id="booking-package" value={packageId} onChange={e => setPackage(e.target.value)}><option value="">Pay per session</option>{managerData.packages.filter(p => p.studentId === studentId && p.usedCredits < p.totalCredits && (!p.serviceId || p.serviceId === serviceId)).map(p => <option key={p.id} value={p.id}>{p.name} · {p.totalCredits - p.usedCredits} credits left</option>)}</select></div>}
    {location?.type === 'HOME' && <div><label htmlFor="booking-address">Student address</label><input id="booking-address" name="address" required placeholder="Full address and unit number" /></div>}
    <div><label htmlFor="booking-notes">Internal lesson notes (optional)</label><textarea id="booking-notes" name="notes" rows={2} placeholder="Preparation, progress, or private provider notes" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team, never on the student booking page.</p></div>
    {location?.requiresApproval && <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800"><AlertCircle size={17} className="shrink-0" />This lesson will be pending venue confirmation. Scheduling does not reserve an external court or room.</div>}
    {repeat > 1 && <p className="text-xs text-stone-500">All {repeat} occurrences must be available. If any week conflicts, no lessons or package credits will be booked.</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
    <div className="flex items-center justify-between gap-4 border-t border-stone-100 pt-5"><div>{managerData ? <ManagerBookingPrice data={managerData} serviceId={serviceId} locationId={locationId} packageId={packageId} repeat={repeat} /> : <p className="text-[11px] leading-relaxed text-stone-500">{repeat} lesson{repeat > 1 ? 's' : ''} · payment details stay with the club.</p>}</div><Button type="submit" disabled={busy || !slot || !studentId}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}Add booking</Button></div>
  </form></DialogContent></Dialog>;
}

function ManagerBookingPrice({ data, serviceId, locationId, packageId, repeat }: { data: ManagerWorkspace; serviceId: string; locationId: string; packageId: string; repeat: number }) {
  const service = data.services.find(item => item.id === serviceId);
  const mapping = service?.locations.find(item => item.locationId === locationId);
  return <><p className="text-lg font-semibold">{packageId ? `${repeat} package credit${repeat > 1 ? 's' : ''}` : money((mapping?.price ?? service?.price ?? 0) * repeat)}</p><p className="mt-1 text-[10px] text-stone-500">{repeat} lesson{repeat > 1 ? 's' : ''} · no payment collected online</p></>;
}

/**
 * One booking, and every decision attached to it.
 *
 * Three things changed shape here. A lesson the club assigned to a coach waits
 * on that coach's acceptance. A time change is proposed and answered rather
 * than applied. And a recorded payment can be taken back, because recording
 * one is a human action and humans mistype.
 */
export function BookingDetail({ bookingId, data, onClose, refresh }: { bookingId: string | null; data: WorkspaceResponse; onClose: () => void; refresh: () => Promise<void> }) {
  const managerData = isManagerWorkspace(data) ? data : null;
  const [busy, setBusy] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [date, setDate] = useState(dateKey());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [proposalMessage, setProposalMessage] = useState('');
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const current = data.bookings.find(booking => booking.id === bookingId) ?? null;
  const managerBooking = managerData?.bookings.find(booking => booking.id === bookingId) ?? null;
  useEffect(() => { setReschedule(false); setSelectedSlot(''); setProposalMessage(''); }, [bookingId]);
  useEffect(() => { let active = true; if (reschedule && current) { setSlots([]); setSelectedSlot(''); loadSlots(data.business.slug, { serviceId: current.serviceId, instructorId: current.instructorId, locationId: current.locationId, date }).then(r => { if (active) setSlots(r.slots); }).catch(e => toast.error(e.message)); } return () => { active = false; }; }, [reschedule, date, bookingId, current, data.business.slug]);
  if (!current) return null;

  async function run<T>(work: () => Promise<T>, success: string) {
    setBusy(true);
    try { await work(); await refresh(); toast.success(success); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }
  async function action(path: string, values: unknown, method: 'PATCH' | 'POST' = 'PATCH') {
    await run(() => mutate(path, method, values), 'Booking updated');
  }

  const inactive = current.status === 'CANCELLED';
  const scheduleClosed = inactive || current.status === 'COMPLETED';
  const awaitingCoach = current.status === 'PENDING' && current.coachAcceptance === 'PENDING';
  const isAssignedCoach = data.user.accountType === 'COACH' && data.user.instructorId === current.instructorId;
  // Accepting an assignment is a teaching decision. The club account manages
  // the roster but never answers on a coach's behalf.
  const canAnswerAssignment = awaitingCoach && isAssignedCoach;
  const openRequest = scheduleClosed ? undefined : data.rescheduleRequests.find(request => request.bookingId === current.id && request.status === 'PENDING');
  const weRaisedRequest = openRequest?.requestedByRole !== 'STUDENT';
  // Payments for this lesson that still count, plus the reversed ones kept for
  // the audit trail.
  const lessonPayments = managerData
    ? managerData.payments.filter(payment => payment.bookingId === current.id && payment.kind !== 'CLUB_TO_COACH')
    : [];
  const activePaymentFor = (studentId: string): Payment | undefined =>
    lessonPayments.find(payment => payment.studentId === studentId && !payment.reversedAt);

  return <Dialog open={!!bookingId} onOpenChange={v => { if (!v && !busy) onClose(); }}><DialogContent className="max-w-lg"><DialogTitle className="pr-7 text-xl font-semibold">{current.serviceName}</DialogTitle><DialogDescription className="mt-2 mb-5 text-xs text-stone-500">Booking details · {current.id.slice(-8).toUpperCase()}</DialogDescription>
    <div className="flex flex-wrap items-center gap-2">
      <span className={`badge ${current.status.toLowerCase()}`}>{current.status === 'PENDING' ? awaitingCoach ? 'Awaiting coach' : 'Venue pending' : current.status.toLowerCase()}</span>
      {current.recurringId && <span className="badge"><Repeat2 size={11} />Weekly lesson</span>}
      {managerBooking && <span className="badge">{managerBooking.paymentRoute === 'CLUB' ? 'Paid through the club' : 'Paid to the coach'}</span>}
    </div>
    <div className="my-5 space-y-3 rounded-xl bg-[#f5f7f1] p-4 text-xs"><p className="flex items-center gap-3"><CalendarDays size={15} className="text-stone-400" />{shortDate(current.startAt)}<span className="ml-auto">{time(current.startAt)} – {time(current.endAt)}</span></p><p className="flex items-center gap-3"><MapPin size={15} className="text-stone-400" />{current.locationName}</p><p className="flex items-center gap-3"><UserRound size={15} className="text-stone-400" />{current.instructorName}</p>{current.address && <p className="pl-7">{current.address}</p>}</div>

    {awaitingCoach && <div className="mb-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
      <p className="leading-relaxed">{current.createdByRole === 'CLUB' ? 'The club assigned this lesson. The student does not need to accept it, but the coach does before it is confirmed.' : 'This lesson is waiting for the coach to accept it.'}</p>
      {canAnswerAssignment && <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void run(() => respondToAssignment(current.id, 'accept'), 'Lesson accepted')}><Check size={13} />Accept lesson</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm('Decline this lesson? The slot is released, any package credit is returned, and the club is asked to reassign it.')) void run(() => respondToAssignment(current.id, 'decline'), 'Lesson declined'); }}><X size={13} />Cannot teach this</Button>
      </div>}
    </div>}

    {current.status === 'PENDING' && !awaitingCoach && <div className="mb-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800"><p className="leading-relaxed">{managerData ? 'Please secure the venue separately, then confirm this session. Courtly has not reserved the court.' : 'Venue confirmation is still pending. The club can confirm it once the court or room is secured.'}</p>{managerData && <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={() => action(`/bookings/${current.id}`, { status: 'CONFIRMED' })}><Check size={13} />Venue secured · confirm</Button>}</div>}

    {openRequest && <div className="mb-5 rounded-lg border border-[#e7dcc1] bg-[#fcf8ee] p-3 text-xs text-[#7a6838]">
      <p className="flex items-center gap-2 font-semibold"><CalendarClock size={14} />{weRaisedRequest ? 'Waiting for the student to reply' : 'The student asked for a new time'}</p>
      <p className="mt-2 leading-relaxed">Proposed: <strong className="font-semibold">{shortDate(openRequest.proposedStartAt)} at {time(openRequest.proposedStartAt)}</strong>. The session keeps its current time until both sides agree.</p>
      {openRequest.message && <p className="mt-2 border-l-2 border-[#e0d3b4] pl-3 italic">“{openRequest.message}”</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {weRaisedRequest
          ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => respondToRescheduleRequest(openRequest.id, 'withdraw'), 'Request withdrawn')}><X size={13} />Withdraw request</Button>
          : <>
            <Button size="sm" disabled={busy} onClick={() => void run(() => respondToRescheduleRequest(openRequest.id, 'accept'), 'New time confirmed')}><Check size={13} />Accept new time</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => respondToRescheduleRequest(openRequest.id, 'decline'), 'Request declined')}><X size={13} />Decline</Button>
          </>}
      </div>
    </div>}

    <h3 className="mb-3 text-xs">Participants · {current.participants.length}/{current.capacity}</h3>
    <div className="space-y-3">{current.participants.map(p => {
      const managerParticipant = managerBooking?.participants.find(participant => participant.id === p.id);
      const payment = activePaymentFor(p.studentId);
      return <div className="rounded-lg border border-stone-200 p-3" key={p.id}>
        <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-semibold">{p.name}</p><p className="mt-1 text-[10px] text-stone-400">{p.email}</p></div>{managerParticipant && <span className={`badge ${!managerParticipant.paid ? 'pending' : ''}`}>{managerParticipant.packageId ? 'Package credit' : managerParticipant.paid ? 'Paid' : `${money(managerParticipant.price)} unpaid`}</span>}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!inactive && !awaitingCoach && <><Button size="sm" variant={p.attendance === 'PRESENT' ? 'default' : 'outline'} disabled={busy} onClick={() => action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'PRESENT' })}><Check size={12} />Attended</Button><Button size="sm" variant={p.attendance === 'ABSENT' ? 'destructive' : 'ghost'} disabled={busy} onClick={() => action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'ABSENT' })}>No-show</Button></>}
          {managerParticipant && !managerParticipant.paid && !managerParticipant.packageId && !inactive && <Button size="sm" variant="outline" disabled={busy} onClick={() => action('/payments', { studentId: p.studentId, bookingId: current.id, amount: managerParticipant.price, method: payMethod, note: 'Lesson payment' }, 'POST')}>Record payment</Button>}
          {/* Recording a payment is undoable: the row stays in the ledger,
              marked reversed, and the participant returns to unpaid. */}
          {managerParticipant && payment && !managerParticipant.packageId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const reason = window.prompt('Reverse this payment? Say briefly why, for the ledger.', 'Recorded by mistake'); if (reason !== null) void run(() => reversePayment(payment.id, reason), 'Payment reversed'); }}><Undo2 size={12} />Undo payment</Button>}
        </div>
        {managerParticipant && payment && <p className="mt-2 text-[10px] text-stone-400">{money(payment.amount)} recorded {shortDate(payment.paidAt)} · {payment.method.replace('_', ' ').toLowerCase()}</p>}
        {managerParticipant && lessonPayments.some(candidate => candidate.studentId === p.studentId && candidate.reversedAt) && <p className="mt-1 text-[10px] text-stone-400">{lessonPayments.filter(candidate => candidate.studentId === p.studentId && candidate.reversedAt).length} reversed payment(s) kept in the ledger.</p>}
      </div>;
    })}</div>

    {managerBooking && managerBooking.participants.some(p => !p.paid && !p.packageId) && !inactive && <div className="mt-4"><label htmlFor="detail-payment-method">Payment recording method</label><select id="detail-payment-method" value={payMethod} onChange={e => setPayMethod(e.target.value)}><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select>{managerBooking.paymentRoute === 'CLUB' && <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-stone-500"><ShieldCheck size={12} className="mt-0.5 shrink-0" />This lesson runs through the club. Record what the student paid the club here, then record the coach&rsquo;s payout under Payments.</p>}</div>}

    <form className="mt-5" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void action(`/bookings/${current.id}`, { notes: String(form.get('notes') || '') }); }}><label htmlFor="detail-notes">Internal lesson notes</label><textarea key={current.id} id="detail-notes" name="notes" rows={3} maxLength={2000} defaultValue={current.notes} placeholder="Goals, progress, and details for your team" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team. Student-submitted context is kept with that participant.</p><Button className="mt-2" type="submit" size="sm" variant="outline" disabled={busy}>Save notes</Button></form>

    {reschedule && !scheduleClosed && <div className="mt-5 space-y-3 rounded-lg bg-stone-50 p-3">
      <label htmlFor="reschedule-date">Propose a new time</label>
      <input id="reschedule-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} />
      <select aria-label="New lesson time" value={selectedSlot} onChange={e => setSelectedSlot(e.target.value)}><option value="">Select available time</option>{slots.filter(s => s.available && s.startAt !== current.startAt).map(s => <option key={s.startAt} value={s.startAt}>{time(s.startAt)}</option>)}</select>
      <div><label htmlFor="reschedule-message">Message to the student <span className="font-normal text-stone-400">(optional)</span></label><input id="reschedule-message" value={proposalMessage} maxLength={500} onChange={e => setProposalMessage(e.target.value)} placeholder="Why the time needs to move" /></div>
      <p className="text-[10px] leading-relaxed text-stone-500">The student has to accept before the session moves. This affects only the selected occurrence, not the full series.</p>
      <Button size="sm" disabled={busy || !selectedSlot} onClick={() => void run(async () => { await proposeWorkspaceReschedule(current.id, selectedSlot, proposalMessage); setReschedule(false); }, 'Request sent to the student')}>Send request<ArrowRight size={13} /></Button>
    </div>}

    {!scheduleClosed && <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-stone-100 pt-4">
      <Button variant="outline" size="sm" disabled={!!openRequest || awaitingCoach} onClick={() => setReschedule(v => !v)}><Clock3 size={13} />{openRequest ? 'Reschedule pending' : 'Propose a new time'}</Button>
      <Button variant="destructive" size="sm" disabled={busy} onClick={() => { if (window.confirm('Cancel this lesson for all participants? Package credits will be returned. Other recurring lessons stay unchanged.')) action(`/bookings/${current.id}`, { status: 'CANCELLED' }); }}>Cancel lesson</Button>
    </div>}
  </DialogContent></Dialog>;
}
