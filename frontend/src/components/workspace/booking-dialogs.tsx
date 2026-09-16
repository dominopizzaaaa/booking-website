'use client';
import { useEffect, useState } from 'react';
import { CalendarDays, Check, Clock3, MapPin, Repeat2, ArrowRight, Loader2, ExternalLink, UserRound, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiError, createBooking, loadSlots, mutate } from '@/lib/api';
import type { Booking, Slot, Workspace } from '@/lib/types';
import { dateKey, money, shortDate, time } from '@/lib/utils';

export function NewBookingDialog({ data, open, onClose, refresh }: { data: Workspace; open: boolean; onClose: () => void; refresh: () => Promise<void> }) {
  const [serviceId, setService] = useState(data.services.find(s => s.active)?.id || '');
  const [locationId, setLocation] = useState('');
  const [instructorId, setInstructor] = useState('');
  const [date, setDate] = useState(dateKey());
  const [slot, setSlot] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [customerId, setCustomer] = useState('');
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
    event.preventDefault(); if (!slot) return;
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await createBooking({ serviceId, locationId, instructorId, startAt: slot, ...(customerId ? { customerId } : { customer: { name: String(form.get('name')), email: String(form.get('email')), phone: String(form.get('phone') || ''), parentName: String(form.get('parentName') || '') } }), repeatWeeks: repeat, ...(packageId ? { packageId } : {}), notes: String(form.get('notes') || ''), address: String(form.get('address') || '') });
      await refresh(); toast.success(repeat > 1 ? `${repeat} weekly lessons booked` : 'Booking added to your schedule'); onClose();
    } catch (e) {
      const err = e as ApiError; const detail = err.details as { conflicts?: { date: string; reason: string }[] } | undefined;
      setError(detail?.conflicts?.length ? `${err.message} ${detail.conflicts.map(c => `${c.date}: ${c.reason}`).join('; ')}` : err.message);
    } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}><DialogContent className="max-w-xl"><DialogTitle className="text-xl font-semibold tracking-tight">Add a booking</DialogTitle><DialogDescription className="mt-2 mb-6 text-xs text-stone-500">A quick booking for the lessons arranged off the court.</DialogDescription><form onSubmit={submit} className="form-stack">
    <div className="form-grid"><div className="field-wide"><label htmlFor="booking-service">Service</label><select id="booking-service" value={serviceId} onChange={e => setService(e.target.value)} required><option value="" disabled>Choose a service</option>{data.services.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div><div><label htmlFor="booking-location">Location</label><select id="booking-location" value={locationId} onChange={e => setLocation(e.target.value)} required><option value="" disabled>Select location</option>{service?.locations.map(l => <option key={l.locationId} value={l.locationId}>{data.locations.find(x => x.id === l.locationId)?.name}</option>)}</select></div><div><label htmlFor="booking-instructor">Instructor</label><select id="booking-instructor" value={instructorId} onChange={e => setInstructor(e.target.value)} required><option value="" disabled>Select instructor</option>{data.instructors.filter(i => mapping?.instructorIds.includes(i.id)).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div><div><label htmlFor="booking-date">Date</label><input id="booking-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} required /></div><div><label htmlFor="booking-repeat">Repeat</label><select id="booking-repeat" value={repeat} onChange={e => setRepeat(Number(e.target.value))}><option value={1}>Does not repeat</option><option value={4}>Weekly · 4 lessons</option><option value={8}>Weekly · 8 lessons</option><option value={10}>Weekly · 10 lessons</option></select></div></div>
    <div><label>Available start times · {mapping?.duration || service?.duration || 60} min</label>{slotsLoading ? <p className="flex items-center gap-2 py-4 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Checking all locations and travel time…</p> : <div className="grid grid-cols-4 gap-2">{slots.filter(s => s.available).map(s => <button type="button" key={s.startAt} onClick={() => setSlot(s.startAt)} className={`rounded-lg border px-2 py-2.5 text-[11px] ${slot === s.startAt ? 'border-[#214e3e] bg-[#214e3e] text-white' : 'border-stone-200 hover:bg-stone-50'}`}>{time(s.startAt)}</button>)}{!slots.some(s => s.available) && <p className="col-span-4 rounded-lg bg-stone-50 p-4 text-xs text-stone-500">No available times. Try a different date, instructor, or location.</p>}</div>}</div>
    <div><label htmlFor="booking-customer">Customer</label><select id="booking-customer" value={customerId} onChange={e => { setCustomer(e.target.value); setPackage(''); }}><option value="">Add a new customer</option>{data.customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    {!customerId && <div className="form-grid"><div><label htmlFor="customer-name">Student name</label><input id="customer-name" name="name" required placeholder="e.g. Alex Chen" /></div><div><label htmlFor="customer-email">Contact email</label><input id="customer-email" type="email" name="email" required placeholder="alex@example.com" /></div><div><label htmlFor="customer-phone">Phone (optional)</label><input id="customer-phone" name="phone" type="tel" placeholder="+65" /></div><div><label htmlFor="customer-parent">Parent or guardian (optional)</label><input id="customer-parent" name="parentName" /></div></div>}
    {customerId && data.packages.some(p => p.customerId === customerId && p.usedCredits < p.totalCredits) && <div><label htmlFor="booking-package">Lesson package</label><select id="booking-package" value={packageId} onChange={e => setPackage(e.target.value)}><option value="">Pay per session</option>{data.packages.filter(p => p.customerId === customerId && p.usedCredits < p.totalCredits && (!p.serviceId || p.serviceId === serviceId)).map(p => <option key={p.id} value={p.id}>{p.name} · {p.totalCredits - p.usedCredits} credits left</option>)}</select></div>}
    {location?.type === 'HOME' && <div><label htmlFor="booking-address">Customer address</label><input id="booking-address" name="address" required placeholder="Full address and unit number" /></div>}
    <div><label htmlFor="booking-notes">Internal lesson notes (optional)</label><textarea id="booking-notes" name="notes" rows={2} placeholder="Preparation, progress, or private provider notes" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team, never on the customer booking page.</p></div>
    {location?.requiresApproval && <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800"><AlertCircle size={17} className="shrink-0" />This lesson will be pending venue confirmation. Scheduling does not reserve an external court or room.</div>}
    {repeat > 1 && <p className="text-xs text-stone-500">All {repeat} occurrences must be available. If any week conflicts, no lessons or package credits will be booked.</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
    <div className="flex items-center justify-between border-t border-stone-100 pt-5"><div><p className="text-lg font-semibold">{packageId ? `${repeat} package credit${repeat > 1 ? 's' : ''}` : money((mapping?.price ?? service?.price ?? 0) * repeat)}</p><p className="mt-1 text-[10px] text-stone-500">{repeat} lesson{repeat > 1 ? 's' : ''} · no payment collected online</p></div><Button type="submit" disabled={busy || !slot}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}Add booking</Button></div>
  </form></DialogContent></Dialog>;
}

export function BookingDetail({ booking, data, onClose, refresh }: { booking: Booking | null; data: Workspace; onClose: () => void; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [date, setDate] = useState(dateKey());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [payMethod, setPayMethod] = useState('BANK_TRANSFER');
  const current = data.bookings.find(b => b.id === booking?.id) || booking;
  useEffect(() => { setReschedule(false); setSelectedSlot(''); }, [booking?.id]);
  useEffect(() => { let active = true; if (reschedule && current) { setSlots([]); setSelectedSlot(''); loadSlots(data.business.slug, { serviceId: current.serviceId, instructorId: current.instructorId, locationId: current.locationId, date }).then(r => { if (active) setSlots(r.slots); }).catch(e => toast.error(e.message)); } return () => { active = false; }; }, [reschedule, date, booking?.id]);
  if (!current) return null;
  async function action(path: string, values: unknown, method: 'PATCH' | 'POST' = 'PATCH') { setBusy(true); try { await mutate(path, method, values); await refresh(); toast.success('Booking updated'); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  const inactive = current.status === 'CANCELLED';
  return <Dialog open={!!booking} onOpenChange={v => { if (!v) onClose(); }}><DialogContent className="max-w-lg"><DialogTitle className="pr-7 text-xl font-semibold">{current.serviceName}</DialogTitle><DialogDescription className="mt-2 mb-5 text-xs text-stone-500">Booking details · {current.id.slice(-8).toUpperCase()}</DialogDescription><div className="flex items-center gap-2"><span className={`badge ${current.status.toLowerCase()}`}>{current.status === 'PENDING' ? 'Venue pending' : current.status.toLowerCase()}</span>{current.recurringId && <span className="badge"><Repeat2 size={11} />Weekly lesson</span>}</div><div className="my-5 space-y-3 rounded-xl bg-[#f5f7f1] p-4 text-xs"><p className="flex items-center gap-3"><CalendarDays size={15} className="text-stone-400" />{shortDate(current.startAt)}<span className="ml-auto">{time(current.startAt)} – {time(current.endAt)}</span></p><p className="flex items-center gap-3"><MapPin size={15} className="text-stone-400" />{current.locationName}</p><p className="flex items-center gap-3"><UserRound size={15} className="text-stone-400" />{current.instructorName}</p>{current.address && <p className="pl-7">{current.address}</p>}</div>
    {current.status === 'PENDING' && <div className="mb-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800"><p className="leading-relaxed">Please secure the venue separately, then confirm this session. Courtly has not reserved the court.</p><Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={() => action(`/bookings/${current.id}`, { status: 'CONFIRMED' })}><Check size={13} />Venue secured · confirm</Button></div>}
    <h3 className="mb-3 text-xs">Participants · {current.participants.length}/{current.capacity}</h3><div className="space-y-3">{current.participants.map(p => <div className="rounded-lg border border-stone-200 p-3" key={p.id}><div className="flex items-center justify-between"><div><p className="text-xs font-semibold">{p.name}</p><p className="mt-1 text-[10px] text-stone-400">{p.email}</p></div><span className={`badge ${!p.paid ? 'pending' : ''}`}>{p.packageId ? 'Package credit' : p.paid ? 'Paid' : `${money(p.price)} unpaid`}</span></div><div className="mt-3 flex flex-wrap gap-2">{!inactive && <><Button size="sm" variant={p.attendance === 'PRESENT' ? 'default' : 'outline'} disabled={busy} onClick={() => action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'PRESENT' })}><Check size={12} />Attended</Button><Button size="sm" variant={p.attendance === 'ABSENT' ? 'destructive' : 'ghost'} disabled={busy} onClick={() => action(`/bookings/${current.id}/participants/${p.id}`, { attendance: 'ABSENT' })}>No-show</Button></>}{!p.paid && !p.packageId && !inactive && data.user.role !== 'COACH' && <Button size="sm" variant="outline" disabled={busy} onClick={() => action('/payments', { customerId: p.customerId, bookingId: current.id, amount: p.price, method: payMethod, note: 'Lesson payment' }, 'POST')}>Record payment</Button>}</div></div>)}</div>
    {current.participants.some(p => !p.paid && !p.packageId) && !inactive && <div className="mt-4"><label htmlFor="detail-payment-method">Payment recording method</label><select id="detail-payment-method" value={payMethod} onChange={e => setPayMethod(e.target.value)}><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></div>}
    <form className="mt-5" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void action(`/bookings/${current.id}`, { notes: String(form.get('notes') || '') }); }}><label htmlFor="detail-notes">Internal lesson notes</label><textarea key={current.id} id="detail-notes" name="notes" rows={3} maxLength={2000} defaultValue={current.notes} placeholder="Goals, progress, and details for your team" /><p className="mt-1 text-[10px] text-stone-400">Visible only to your team. Customer-submitted context is kept with that participant.</p><Button className="mt-2" type="submit" size="sm" variant="outline" disabled={busy}>Save notes</Button></form>
    {reschedule && <div className="mt-5 space-y-3 rounded-lg bg-stone-50 p-3"><label htmlFor="reschedule-date">Move this lesson to</label><input id="reschedule-date" type="date" min={dateKey()} value={date} onChange={e => setDate(e.target.value)} /><select aria-label="New lesson time" value={selectedSlot} onChange={e => setSelectedSlot(e.target.value)}><option value="">Select available time</option>{slots.filter(s => s.available).map(s => <option key={s.startAt} value={s.startAt}>{time(s.startAt)}</option>)}</select><p className="text-[10px] text-stone-500">This moves only the selected occurrence, not the full series.</p><Button size="sm" disabled={busy || !selectedSlot} onClick={async () => { await action(`/bookings/${current.id}/reschedule`, { startAt: selectedSlot }, 'POST'); setReschedule(false); }}>Save new time<ArrowRight size={13} /></Button></div>}
    {!inactive && <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-stone-100 pt-4"><Button variant="outline" size="sm" onClick={() => setReschedule(v => !v)}><Clock3 size={13} />Reschedule</Button><Button variant="destructive" size="sm" disabled={busy} onClick={() => { if (window.confirm('Cancel this lesson for all participants? Package credits will be returned. Other recurring lessons stay unchanged.')) action(`/bookings/${current.id}`, { status: 'CANCELLED' }); }}>Cancel lesson</Button></div>}
  </DialogContent></Dialog>;
}
