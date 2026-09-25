'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDownLeft, Banknote, CalendarDays, CreditCard, Package, Search, Wallet, CircleCheck, Clock3, Undo2, ShieldCheck, Pencil, Trash2, Loader2, MapPin, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, createPackageOffer, deletePackageOffer, loadPackageOffers, loadRental, mutate, recordCoachPayout, reversePayment, updatePackageOffer } from '@/lib/api';
import type { ManagerWorkspace, PackageOffer, PackageOfferInput, Payment } from '@/lib/types';
import { addDaysKey, dateKey, endOfDateKey, money, shortDate, time } from '@/lib/utils';
import { CheckField, Editor, Empty, Field, PageHeading, Stat, StateBadge, cents, errorMessage, numeric, text, type ManagementProps } from './management-ui';
import { purchasedPackageScopes, purchasedPackageState } from './package-reporting';

export type PaymentTarget = { key: string; studentId: string; studentName: string; label: string; amount: number; bookingId?: string; packageId?: string };
export function paymentTargets(data: ManagerWorkspace): PaymentTarget[] {
  return [
    ...data.bookings.filter(b => b.status !== 'CANCELLED').flatMap(booking => booking.participants.filter(p => !p.paid && !p.packageId && p.price > 0).map(p => ({ key: `booking:${booking.id}:${p.id}`, studentId: p.studentId, studentName: p.name, bookingId: booking.id, label: `${booking.serviceName} · ${shortDate(booking.startAt)} · ${time(booking.startAt)}`, amount: p.price }))),
    ...data.packages.filter(p => !p.paid && p.price > 0).map(p => ({ key: `package:${p.id}`, studentId: p.studentId, studentName: p.studentName, packageId: p.id, label: `${p.name} · ${p.totalCredits} credits`, amount: p.price })),
  ];
}

function PaymentHistoryCards({ payments, data, busy, onUndo }: { payments: Payment[]; data: ManagerWorkspace; busy: boolean; onUndo: (paymentId: string) => void }) {
  return <div className="divide-y divide-[#edf0e8] sm:hidden">{payments.map(payment => {
    const booking = data.bookings.find(b => b.id === payment.bookingId);
    const pkg = data.packages.find(p => p.id === payment.packageId);
    const subject = booking?.serviceName || pkg?.name || (payment.bookingId ? 'Class payment' : payment.packageId ? 'Package payment' : 'Unallocated payment');
    return <article key={payment.id} className={`p-4 ${payment.reversedAt ? 'opacity-60' : ''}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm text-[#294735]">{payment.kind === 'CLUB_TO_COACH' ? payment.instructorName : payment.studentName}</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{payment.kind === 'CLUB_TO_COACH' ? 'Coach payout' : subject}</p></div><strong className={`shrink-0 text-sm font-semibold ${payment.reversedAt ? 'text-stone-400 line-through' : 'text-[#254b38]'}`}>{money(payment.amount)}</strong></div><div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-stone-500"><span className="badge bg-[#f2f4ee]! text-[#59675c]!">{methodNames[payment.method]}</span><span>{kindNames[payment.kind] || 'Payment'}</span><span>{shortDate(payment.paidAt)} · {time(payment.paidAt)}</span>{payment.reversedAt && <span className="badge cancelled !text-[9px]" title={payment.reversedReason}>Reversed</span>}</div>{payment.note && <p className="mt-3 break-words rounded-lg bg-[#f7f8f5] px-3 py-2 text-[10px] leading-relaxed text-[#59675c]">{payment.note}</p>}{!payment.reversedAt && <div className="mt-3 flex justify-end"><Button variant="ghost" size="sm" disabled={busy} onClick={() => onUndo(payment.id)}><Undo2 size={12} />Undo</Button></div>}</article>;
  })}</div>;
}

function OutstandingCards({ targets, onRecord }: { targets: PaymentTarget[]; onRecord: (target: PaymentTarget) => void }) {
  return <div className="divide-y divide-[#edf0e8] sm:hidden">{targets.map(target => <article key={target.key} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm text-[#294735]">{target.studentName}</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{target.label}</p></div><strong className="shrink-0 text-sm font-semibold text-[#254b38]">{money(target.amount)}</strong></div><div className="mt-4 flex items-center justify-between gap-3"><span className="text-[10px] text-stone-400">{target.packageId ? 'Package purchase' : 'Student class price'}</span><Button variant="outline" size="sm" onClick={() => onRecord(target)}>Record payment</Button></div></article>)}</div>;
}

export function PackageEditor({ data, refresh, onClose, studentId }: ManagementProps & { onClose: () => void; studentId?: string }) {
  const [paid, setPaid] = useState(false);
  return <Editor title="Sell a class package" description="Give a student a set of package credits. Credits are deducted when they book, and returned if the booking is cancelled." onClose={onClose} refresh={refresh} success="Package created" submitLabel="Create package" disabled={!data.students.length} onSubmit={form => {
    const expiry = text(form, 'expiresAt');
    if (expiry < dateKey(new Date(), data.business.timezone)) throw new Error('Choose an expiry date today or later.');
    return mutate('/packages', 'POST', { studentId: text(form, 'package-student'), name: text(form, 'name'), serviceId: text(form, 'package-service') || null, totalCredits: numeric(form, 'totalCredits'), price: cents(text(form, 'price')), expiresAt: endOfDateKey(expiry, data.business.timezone).toISOString(), paid });
  }}><div className="form-grid max-sm:grid-cols-1!"><Field label="Student" name="package-student" wide><select id="package-student" name="package-student" required defaultValue={studentId || ''}><option value="" disabled>Select a student</option>{data.students.map(student => <option key={student.id} value={student.id}>{student.name} · {student.email}</option>)}</select>{!data.students.length && <p className="mt-2 text-xs text-amber-800">Add a student before selling a package.</p>}</Field><Field label="Package name" name="name" required wide placeholder="e.g. 10-class tennis pass" /><Field label="Eligible class" name="package-service" wide><select id="package-service" name="package-service" defaultValue=""><option value="">Any class</option>{data.services.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Package credits" name="totalCredits" type="number" required min="1" max="500" step="1" defaultValue="10" /><Field label={`Package price (${data.business.currency})`} name="price" type="number" required min="0" step="0.01" placeholder="700.00" /><Field label="Expiry date" name="expiresAt" type="date" required min={dateKey(new Date(), data.business.timezone)} defaultValue={addDaysKey(dateKey(new Date(), data.business.timezone), 180, data.business.timezone)} wide /></div><CheckField label="Payment already received" checked={paid} onChange={e => setPaid(e.target.checked)} hint="Only select this if you have already received the full package price offline." />{paid && <p className="rounded-lg bg-[#eff3e9] p-3 text-xs leading-relaxed text-[#697d5e]">This records the package as paid. No online charge is made. To choose a payment method and note, leave this off and record the payment from Payments after creating the package.</p>}</Editor>;
}

export function PaymentEditor({ data, refresh, onClose, target: initialTarget, studentId: initialStudent }: ManagementProps & { onClose: () => void; target?: PaymentTarget; studentId?: string }) {
  const [studentId, setStudent] = useState(initialTarget?.studentId || initialStudent || '');
  const [targetKey, setTarget] = useState(initialTarget?.key || '');
  const targets = paymentTargets(data).filter(target => target.studentId === studentId);
  const selected = targets.find(t => t.key === targetKey);
  const other = targetKey === 'other';
  return <Editor title="Record a payment" description="Keep a record of money already received. This does not charge a card, send an invoice, or transfer funds." onClose={onClose} refresh={refresh} success="Payment recorded" submitLabel="Record payment" disabled={!studentId || (!selected && !other)} onSubmit={form => {
    if (!studentId || (!selected && !other)) throw new Error('Choose a student and what this payment is for.');
    if (initialTarget && !selected && !other) throw new Error('This item may already have been paid. Please refresh and try again.');
    const amount = selected ? selected.amount : cents(text(form, 'amount'));
    if (amount <= 0) throw new Error('The payment amount must be greater than zero.');
    return mutate('/payments', 'POST', { studentId, ...(selected?.bookingId ? { bookingId: selected.bookingId } : {}), ...(selected?.packageId ? { packageId: selected.packageId } : {}), amount, method: text(form, 'payment-method'), note: text(form, 'note') });
  }}><div className="form-grid max-sm:grid-cols-1!"><Field label="Student" name="payment-student" wide><select id="payment-student" value={studentId} required onChange={event => { setStudent(event.target.value); setTarget(''); }}><option value="" disabled>Select a student</option>{data.students.map(student => <option key={student.id} value={student.id}>{student.name} · {student.email}</option>)}</select></Field><Field label="Payment for" name="payment-target" wide><select id="payment-target" required value={targetKey} onChange={event => setTarget(event.target.value)} disabled={!studentId}><option value="" disabled>Select an unpaid item</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label} · {money(target.amount)}</option>)}<option value="other">Other · unallocated payment</option></select></Field>{selected ? <Field label="Exact amount (SGD)" name="amount" type="number" value={(selected.amount / 100).toFixed(2)} readOnly hint="Linked payments settle this student's full participant price or package price. Partial or extra amounts cannot be recorded against it." /> : <Field key={targetKey} label="Amount received (SGD)" name="amount" type="number" min="0.01" step="0.01" required disabled={!other} placeholder="0.00" />}<Field label="Payment method" name="payment-method"><select id="payment-method" name="payment-method" required defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></Field><Field label={other ? 'What was this payment for?' : 'Reference or note (optional)'} name="payment-note" wide><textarea id="payment-note" name="note" rows={3} required={other} placeholder={other ? 'Describe the reason for this payment' : 'e.g. PayNow reference or receipt number'} /></Field></div>{other && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">An unallocated payment does not mark a class or package as paid. Choose the unpaid item above to settle a balance.</p>}{!data.students.length && <p className="text-xs text-amber-800">Add a student first to record a payment.</p>}</Editor>;
}

function PackageOfferEditor({ offer, data, rentalLocations, rentalsLoading, rentalsError, retryRentals, refreshOffers, onClose }: {
  offer: PackageOffer | null;
  data: ManagerWorkspace;
  rentalLocations: Array<{ id: string; name: string }>;
  rentalsLoading: boolean;
  rentalsError: string;
  retryRentals: () => Promise<void>;
  refreshOffers: () => Promise<void>;
  onClose: () => void;
}) {
  const initialServiceIds = offer?.serviceIds?.length
    ? offer.serviceIds
    : offer?.services?.map(service => service.id) ?? [];
  const initialRentalLocationIds = offer?.rentalLocationIds?.length
    ? offer.rentalLocationIds
    : offer?.rentalLocations?.map(location => location.id) ?? [];
  const [serviceIds, setServiceIds] = useState(initialServiceIds);
  const [rentalLocationIds, setRentalLocationIds] = useState(initialRentalLocationIds);
  const eligibleServices = data.services.filter(service => service.active || serviceIds.includes(service.id));
  const publishedRentalIds = new Set(rentalLocations.map(location => location.id));
  const eligibleRentalLocations = [...new Map([
    ...(offer?.rentalLocations ?? []).map(location => [location.id, location] as const),
    ...rentalLocations.map(location => [location.id, location] as const),
  ]).values()];

  function toggle(current: string[], value: string, checked: boolean) {
    return checked ? [...current, value] : current.filter(id => id !== value);
  }

  return <Editor
    title={offer ? 'Edit package offer' : 'Create a package offer'}
    description="Define the bundle students can buy. Each credit can be used for one eligible class or one rental booking."
    wide
    onClose={onClose}
    refresh={refreshOffers}
    success={offer ? 'Package offer updated' : 'Package offer created'}
    submitLabel={offer ? 'Save offer' : 'Create offer'}
    onSubmit={async form => {
      const totalCredits = numeric(form, 'totalCredits');
      const validityDays = numeric(form, 'validityDays');
      if (!Number.isInteger(totalCredits) || totalCredits < 1) throw new Error('Credits must be a whole number greater than zero.');
      if (!Number.isInteger(validityDays) || validityDays < 1) throw new Error('Validity must be a whole number of days greater than zero.');
      if (!serviceIds.length && !rentalLocationIds.length) throw new Error('Choose at least one eligible class or rental location.');
      const values: PackageOfferInput = {
        name: text(form, 'name'),
        description: text(form, 'description'),
        price: cents(text(form, 'price')),
        totalCredits,
        validityDays,
        active: form.has('active'),
        serviceIds,
        rentalLocationIds,
      };
      if (offer) await updatePackageOffer(offer.id, values);
      else await createPackageOffer(values);
    }}
  >
    <div className="form-grid max-sm:grid-cols-1!">
      <Field label="Offer name" name="name" required wide defaultValue={offer?.name} placeholder="e.g. 10-credit tennis pass" />
      <Field label="Description" name="offer-description" wide>
        <textarea id="offer-description" name="description" rows={3} maxLength={2000} defaultValue={offer?.description} placeholder="What the package includes and who it suits" />
      </Field>
      <Field label="Credits" name="totalCredits" type="number" min="1" max="1000" step="1" required defaultValue={offer?.totalCredits ?? 10} />
      <Field label="Price (SGD)" name="price" type="number" min="0.01" step="0.01" required defaultValue={offer ? (offer.price / 100).toFixed(2) : undefined} placeholder="700.00" />
      <Field label="Valid for (days)" name="validityDays" type="number" min="1" max="3650" step="1" required defaultValue={offer?.validityDays ?? 180} wide hint="The expiry date is set from the student's purchase date." />
    </div>
    <section className="rounded-xl border border-[#e6eae3] p-4" aria-labelledby="offer-classes-heading">
      <h3 id="offer-classes-heading" className="flex items-center gap-2 text-sm text-[#294735]"><BookOpen size={15} />Eligible classes</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-stone-500">A credit can be used when the student books any selected class.</p>
      {eligibleServices.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{eligibleServices.map(service => <CheckField key={service.id} label={`${service.name}${service.active ? '' : ' (archived)'}`} checked={serviceIds.includes(service.id)} onChange={event => setServiceIds(current => toggle(current, service.id, event.target.checked))} />)}</div> : <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Create an active class to include classes in this offer.</p>}
    </section>
    <section className="rounded-xl border border-[#e6eae3] p-4" aria-labelledby="offer-rentals-heading">
      <h3 id="offer-rentals-heading" className="flex items-center gap-2 text-sm text-[#294735]"><MapPin size={15} />Rentable locations</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-stone-500">A credit can also cover one rental booking at any selected location.</p>
      {rentalsLoading && <p className="mt-3 flex items-center gap-2 text-xs text-stone-500"><Loader2 size={13} className="animate-spin" />Loading rental locations…</p>}
      {rentalsError && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-3"><p role="alert" className="text-xs text-amber-800">{rentalsError}</p><Button type="button" size="sm" variant="outline" onClick={() => void retryRentals()}>Try again</Button></div>}
      {eligibleRentalLocations.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{eligibleRentalLocations.map(location => <CheckField key={location.id} label={`${location.name}${publishedRentalIds.has(location.id) ? '' : ' (unavailable)'}`} checked={rentalLocationIds.includes(location.id)} onChange={event => setRentalLocationIds(current => toggle(current, location.id, event.target.checked))} />)}</div> : !rentalsLoading && !rentalsError ? <p className="mt-3 text-xs text-stone-500">No active rentable locations are available. You can still create a class-only offer.</p> : null}
    </section>
    <CheckField name="active" label="Available for purchase" defaultChecked={offer?.active ?? true} hint="Turn this off to hide the offer from students without changing packages they already bought." />
  </Editor>;
}

export function PackagesView({ data, refresh }: ManagementProps) {
  const isClub = data.user.accountType === 'CLUB';
  const [editing, setEditing] = useState<PackageOffer | null | undefined>();
  const [offers, setOffers] = useState<PackageOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(isClub);
  const [offersError, setOffersError] = useState('');
  const [rentalLocations, setRentalLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [rentalsLoading, setRentalsLoading] = useState(isClub);
  const [rentalsError, setRentalsError] = useState('');
  const [deletingId, setDeletingId] = useState<string>();
  const [filter, setFilter] = useState('all');
  const activePackages = data.packages.filter(p => purchasedPackageState(p) === 'ACTIVE');
  const packages = data.packages.filter(p => {
    const state = purchasedPackageState(p);
    return filter === 'all' || (filter === 'active' && state === 'ACTIVE')
      || (filter === 'unpaid' && state === 'UNPAID') || (filter === 'expired' && state === 'EXPIRED');
  });
  const refreshOffers = useCallback(async () => {
    if (!isClub) return;
    setOffersLoading(true);
    setOffersError('');
    try {
      const result = await loadPackageOffers();
      setOffers(result.offers);
    } catch (error) {
      setOffersError(errorMessage(error));
    } finally {
      setOffersLoading(false);
    }
  }, [isClub]);

  const refreshRentalLocations = useCallback(async () => {
    if (!isClub) return;
    setRentalsLoading(true);
    setRentalsError('');
    try {
      const results = await Promise.all(data.locations.map(async location => {
        try {
          const rental = await loadRental(location.id);
          return rental.enabled ? { id: rental.locationId, name: rental.name } : null;
        } catch (error) {
          // Most teaching locations are not rentals. Their 404 must not hide
          // the configured venues returned by the other independent reads.
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      }));
      setRentalLocations(results.filter((location): location is { id: string; name: string } => location !== null)
        .sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      setRentalsError(errorMessage(error));
    } finally {
      setRentalsLoading(false);
    }
  }, [data.locations, isClub]);

  useEffect(() => { void refreshOffers(); }, [refreshOffers]);
  useEffect(() => { void refreshRentalLocations(); }, [refreshRentalLocations]);

  async function removeOffer(offer: PackageOffer) {
    if (!window.confirm(`Remove ${offer.name}? Offers with purchase history will be archived instead.`)) return;
    setDeletingId(offer.id);
    try {
      const result = await deletePackageOffer(offer.id);
      await refreshOffers();
      toast.success(result.archived ? 'Package offer archived' : 'Package offer deleted');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDeletingId(undefined);
    }
  }

  return <>
    <PageHeading title={isClub ? 'Package offers' : 'Purchased packages'} description={isClub ? 'Create the credit bundles students can purchase for eligible classes and rental locations.' : 'Review package credits already issued from this legacy practice.'} action={isClub ? () => setEditing(null) : undefined} actionLabel="Create offer" />
    {isClub && <section className="mb-8" aria-labelledby="package-offer-catalog-heading">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 id="package-offer-catalog-heading" className="text-base text-[#294735]">Offers for sale</h2><p className="mt-1 text-[11px] text-stone-500">Inactive offers remain here for reference but are hidden from students.</p></div>{!offersLoading && !offersError && <p className="text-xs text-stone-500"><strong className="font-semibold text-[#405941]">{offers.filter(offer => offer.active).length}</strong> active</p>}</div>
      {offersLoading ? <div className="panel flex min-h-48 items-center justify-center gap-2 text-xs text-stone-500"><Loader2 size={16} className="animate-spin" />Loading package offers…</div> : offersError ? <div className="panel flex min-h-48 flex-col items-center justify-center gap-3 p-5 text-center"><p role="alert" className="text-xs text-red-700">{offersError}</p><Button variant="outline" size="sm" onClick={() => void refreshOffers()}>Try again</Button></div> : offers.length ? <div className="cards-grid">{offers.map(offer => {
        const classNames = offer.services?.map(service => service.name) ?? [];
        const rentalNames = offer.rentalLocations?.map(location => location.name) ?? [];
        return <article key={offer.id} className="panel flex flex-col p-5"><div className="flex items-start justify-between gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff3e8] text-[#83946f]"><Package size={21} strokeWidth={1.5} /></span><StateBadge active={offer.active} /></div><h3 className="mt-4 text-base text-[#294735]">{offer.name}</h3><p className="mt-2 min-h-10 text-xs leading-relaxed text-stone-500">{offer.description || 'A flexible credit bundle for Courtly students.'}</p><div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-[#f7f9f4] p-3"><p><strong className="block text-lg font-semibold text-[#254b38]">{offer.totalCredits}</strong><span className="text-[10px] text-stone-500">credits</span></p><p><strong className="block text-lg font-semibold text-[#254b38]">{money(offer.price, data.business.currency)}</strong><span className="text-[10px] text-stone-500">valid {offer.validityDays} days</span></p></div><dl className="mt-4 space-y-2 text-[11px] text-stone-500">{classNames.length > 0 && <div className="flex items-start gap-2"><dt className="flex shrink-0 items-center gap-1 font-medium text-[#405941]"><BookOpen size={12} />Classes</dt><dd className="min-w-0">{classNames.join(', ')}</dd></div>}{rentalNames.length > 0 && <div className="flex items-start gap-2"><dt className="flex shrink-0 items-center gap-1 font-medium text-[#405941]"><MapPin size={12} />Rentals</dt><dd className="min-w-0">{rentalNames.join(', ')}</dd></div>}</dl><div className="mt-auto flex gap-2 pt-5"><Button variant="outline" size="sm" className="flex-1" onClick={() => setEditing(offer)}><Pencil size={13} />Edit</Button><Button variant="ghost" size="sm" disabled={deletingId === offer.id} aria-label={`Remove ${offer.name}`} onClick={() => void removeOffer(offer)}>{deletingId === offer.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}Remove</Button></div></article>;
      })}</div> : <div className="panel"><Empty title="Build your first package offer" icon={Package} action={<Button size="sm" onClick={() => setEditing(null)}>Create offer</Button>}>Bundle credits across selected classes and rental locations, then make the offer available for students to buy.</Empty></div>}
    </section>}
    <section aria-labelledby="purchased-packages-heading">
      <div className="mb-4"><h2 id="purchased-packages-heading" className="text-base text-[#294735]">Purchased packages</h2><p className="mt-1 text-[11px] text-stone-500">Read-only entitlement reporting for packages already issued to students.</p></div>
    <div className="stat-grid grid-cols-2! sm:grid-cols-3! [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1"><Stat label="Active packages" value={activePackages.length} detail="Paid, unexpired, with credits remaining" icon={Package} /><Stat label="Available credits" value={activePackages.reduce((sum, p) => sum + p.totalCredits - p.usedCredits, 0)} detail="Across all active packages" icon={LayersIcon} /><Stat label="Package balance due" value={money(data.packages.filter(p => !p.paid).reduce((sum, p) => sum + p.price, 0), data.business.currency)} detail="Packages not yet marked paid" icon={Wallet} /></div>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e9e0] bg-white p-3 sm:px-4"><p className="text-xs text-stone-500"><strong className="font-semibold text-[#405941]">{packages.length}</strong> package{packages.length === 1 ? '' : 's'}</p><select aria-label="Filter packages" value={filter} onChange={e => setFilter(e.target.value)} className="text-xs max-sm:w-full sm:max-w-44"><option value="all">All packages</option><option value="active">Active packages</option><option value="unpaid">Unpaid packages</option><option value="expired">Expired packages</option></select></div>
    {packages.length ? <div className="cards-grid">{packages.map(p => {
      const state = purchasedPackageState(p);
      const expired = state === 'EXPIRED';
      const remaining = Math.max(0, p.totalCredits - p.usedCredits);
      const scopes = purchasedPackageScopes(p, data.services, data.locations);
      const status = state === 'UNPAID' ? 'Payment due' : state === 'EXPIRED' ? 'Expired' : state === 'EXHAUSTED' ? 'Used up' : 'Active';
      return <article key={p.id} className="panel flex flex-col p-5 transition-shadow hover:shadow-sm"><div className="flex items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff3e8] text-[#83946f]"><Package size={21} strokeWidth={1.5} /></span><span className={`badge ${state === 'UNPAID' ? 'pending' : expired ? 'cancelled' : state === 'EXHAUSTED' ? 'completed' : ''}`}>{status}</span></div><h2 className="mt-4 text-base text-[#294735]">{p.name}</h2><p className="mt-1 text-xs text-stone-500">{p.studentName}</p><dl className="mt-4 space-y-1.5 text-[10px] text-stone-500">{scopes.classNames.length > 0 && <div><dt className="inline font-semibold text-[#405941]">Classes: </dt><dd className="inline">{scopes.classNames.join(', ')}</dd></div>}{scopes.rentalNames.length > 0 && <div><dt className="inline font-semibold text-[#405941]">Rentals: </dt><dd className="inline">{scopes.rentalNames.join(', ')}</dd></div>}</dl><div className="mt-4 flex items-end justify-between gap-2"><p><strong className="text-2xl font-semibold tracking-tight text-[#254b38]">{remaining}</strong><span className="ml-1 text-xs text-stone-500">credits left</span></p><span className="text-[10px] text-stone-400">{p.usedCredits} of {p.totalCredits} used</span></div><div role="progressbar" aria-label={`${p.name} used credits`} aria-valuemin={0} aria-valuemax={p.totalCredits} aria-valuenow={Math.min(p.usedCredits, p.totalCredits)} className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf0e7]"><div className="h-full rounded-full bg-[#66885a]" style={{ width: `${Math.min(100, p.totalCredits ? p.usedCredits / p.totalCredits * 100 : 0)}%` }} /></div><p className="mt-4 flex items-center gap-2 text-[11px] text-stone-500"><CalendarDays size={12} />{expired ? 'Expired' : 'Expires'} {shortDate(p.expiresAt, data.business.timezone)} {dateKey(p.expiresAt, data.business.timezone).slice(0, 4)}</p><div className="mt-auto pt-5"><div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0e8] pt-4"><span className="text-base font-semibold text-[#254b38]">{money(p.price, data.business.currency)}</span>{p.price === 0 ? <span className="badge">No payment due</span> : p.paid ? <span className="badge"><CircleCheck size={10} />Paid</span> : <span className="badge pending">Payment due</span>}</div></div></article>;
    })}</div> : <div className="panel"><Empty title="No purchased packages yet" icon={Package}>Student purchases and their remaining credits will appear here.</Empty></div>}
    </section>
    {editing !== undefined && <PackageOfferEditor offer={editing} data={data} rentalLocations={rentalLocations} rentalsLoading={rentalsLoading} rentalsError={rentalsError} retryRentals={refreshRentalLocations} refreshOffers={refreshOffers} onClose={() => setEditing(undefined)} />}
  </>;
}

const LayersIcon = CreditCard;
const methodNames: Record<string, string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  SIMULATED_STRIPE: 'Simulated Stripe',
  OTHER: 'Other',
};
const kindNames: Record<string, string> = {
  STUDENT_TO_CLUB: 'Student → club',
  STUDENT_TO_COACH: 'Student → coach',
  CLUB_TO_COACH: 'Club → coach',
};

/**
 * What the club pays a coach for work already done.
 *
 * A club lesson is two movements of money, not one: the student pays the club,
 * then the club pays the coach. Recording only the first leaves a club unable
 * to answer the question its coaches actually ask — how much am I owed?
 */
function PayoutEditor({ data, refresh, onClose }: ManagementProps & { onClose: () => void }) {
  const activeInstructors = data.instructors.filter(instructor => instructor.active);
  return <Editor
    title="Record a coach payout"
    description="Money your club has paid a coach for classes already taught. This does not transfer funds; it records what you have paid."
    onClose={onClose}
    refresh={refresh}
    success="Coach payout recorded"
    submitLabel="Record payout"
    disabled={!activeInstructors.length}
    onSubmit={form => recordCoachPayout({
      instructorId: text(form, 'payout-instructor'),
      amount: cents(text(form, 'amount')),
      method: text(form, 'payout-method'),
      note: text(form, 'note'),
    })}
  >
    <div className="form-grid max-sm:grid-cols-1!">
      <Field label="Coach" name="payout-instructor" wide><select id="payout-instructor" name="payout-instructor" required defaultValue=""><option value="" disabled>Select a coach</option>{activeInstructors.map(instructor => <option key={instructor.id} value={instructor.id}>{instructor.name}</option>)}</select>{!activeInstructors.length && <p className="mt-2 text-xs text-amber-800">Add or reactivate a coach before recording a payout.</p>}</Field>
      <Field label="Amount paid (SGD)" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" />
      <Field label="Payment method" name="payout-method"><select id="payout-method" name="payout-method" required defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></Field>
      <Field label="Reference or period (optional)" name="payout-note" wide><textarea id="payout-note" name="note" rows={2} placeholder="e.g. March classes, 12 sessions" /></Field>
    </div>
  </Editor>;
}
export function PaymentsView({ data, refresh }: ManagementProps) {
  const [record, setRecord] = useState<{ target?: PaymentTarget }>();
  const [payout, setPayout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'history' | 'outstanding'>('history');
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const outstandingTabRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const targets = paymentTargets(data);
  const month = dateKey().slice(0, 7);
  const isClub = data.business.kind === 'CLUB';
  // A reversed payment stays in the ledger for the audit trail but counts
  // towards nothing, so every total here filters it out.
  const live = data.payments.filter(payment => !payment.reversedAt);
  const collected = live.filter(payment => payment.kind !== 'CLUB_TO_COACH');
  const paidOut = live.filter(payment => payment.kind === 'CLUB_TO_COACH');
  const payments = [...data.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt)).filter(p => `${p.studentName ?? ''} ${p.instructorName ?? ''} ${p.note} ${methodNames[p.method]}`.toLowerCase().includes(query.toLowerCase()));
  const outstanding = targets.filter(t => `${t.studentName} ${t.label}`.toLowerCase().includes(query.toLowerCase()));

  async function undo(paymentId: string) {
    const reason = window.prompt('Reverse this payment? Say briefly why, for the ledger.', 'Recorded by mistake');
    if (reason === null) return;
    setBusy(true);
    try { await reversePayment(paymentId, reason); await refresh(); toast.success('Payment reversed'); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: 'history' | 'outstanding') {
    const paymentTabs = ['history', 'outstanding'] as const;
    const currentIndex = paymentTabs.indexOf(current);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % paymentTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + paymentTabs.length) % paymentTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = paymentTabs.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const next = paymentTabs[nextIndex];
    setTab(next);
    (next === 'history' ? historyTabRef : outstandingTabRef).current?.focus();
  }

  return <>
    <PageHeading title="Payments" description={isClub ? 'Money the club collects from students, and what it pays its coaches. Recorded by hand; nothing is charged or transferred here.' : 'A clear picture of money in and balances due. Record the payments you receive offline.'} action={() => setRecord({})} actionLabel="Record payment" />
    <div className="stat-grid"><Stat label="Recorded this month" value={money(collected.filter(p => dateKey(p.paidAt).startsWith(month)).reduce((sum, p) => sum + p.amount, 0))} detail="Based on the date payments were recorded" icon={ArrowDownLeft} /><Stat label="Collected from students" value={money(collected.reduce((sum, p) => sum + p.amount, 0))} detail={`${collected.length} payment records · all time`} icon={Banknote} />{isClub ? <Stat label="Paid to coaches" value={money(paidOut.reduce((sum, p) => sum + p.amount, 0))} detail={`${paidOut.length} payout${paidOut.length === 1 ? '' : 's'} recorded`} icon={Wallet} /> : <Stat label="Outstanding" value={money(targets.reduce((sum, t) => sum + t.amount, 0))} detail="Unpaid classes and packages" icon={Wallet} />}<Stat label="Items awaiting payment" value={targets.length} detail="Cancelled classes are excluded" icon={Clock3} /></div>
    {isClub && <div className="mb-5 flex flex-col gap-3 rounded-xl border border-[#e3e9db] bg-[#f4f7ef] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2.5 text-xs leading-relaxed text-[#66755f]"><ShieldCheck size={16} className="mt-0.5 shrink-0" />Classes booked through {data.business.name} are paid to the club. Record what you then pay each coach so both sides of the ledger stay complete.</p>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPayout(true)}><Wallet size={13} />Record coach payout</Button>
    </div>}
    <section className="panel overflow-hidden [&_.text-stone-400]:!text-[#59675c]" aria-label="Payment records">
      <div className="panel-heading flex-wrap border-b border-[#edf0e8]"><div className="tab-bar w-full sm:w-auto" role="tablist" aria-label="Payments view"><button ref={historyTabRef} id="payment-history-tab" type="button" role="tab" tabIndex={tab === 'history' ? 0 : -1} aria-selected={tab === 'history'} aria-controls="payment-history-panel" className={`flex-1 sm:flex-none ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')} onKeyDown={event => handleTabKeyDown(event, 'history')}>Payment history</button><button ref={outstandingTabRef} id="payment-outstanding-tab" type="button" role="tab" tabIndex={tab === 'outstanding' ? 0 : -1} aria-selected={tab === 'outstanding'} aria-controls="payment-outstanding-panel" className={`flex-1 sm:flex-none ${tab === 'outstanding' ? 'active' : ''}`} onClick={() => setTab('outstanding')} onKeyDown={event => handleTabKeyDown(event, 'outstanding')}>Outstanding ({targets.length})</button></div><div className="relative w-full sm:max-w-72"><Search size={14} className="pointer-events-none absolute top-3.5 left-3 text-stone-400" /><input className="pl-9! text-xs!" type="search" aria-label="Search payments" placeholder="Search student or reference…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
      {tab === 'history' ? <div id="payment-history-panel" role="tabpanel" aria-labelledby="payment-history-tab">{payments.length ? <><div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Student</th><th>Payment for</th><th>Received</th><th>Method</th><th className="text-right!">Amount</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{payments.map(payment => { const booking = data.bookings.find(b => b.id === payment.bookingId); const pkg = data.packages.find(p => p.id === payment.packageId); const reversed = !!payment.reversedAt; return <tr key={payment.id} className={reversed ? 'opacity-60' : undefined}><td><p className="font-medium">{payment.kind === 'CLUB_TO_COACH' ? payment.instructorName || payment.studentName : payment.studentName}</p><p className="mt-1 max-w-52 truncate text-[10px] text-stone-400" title={payment.note}>{payment.note || 'No reference'}</p></td><td>{payment.kind === 'CLUB_TO_COACH' ? 'Coach payout' : booking?.serviceName || pkg?.name || (payment.bookingId ? 'Class payment' : payment.packageId ? 'Package payment' : 'Unallocated payment')}<p className="mt-1 text-[10px] text-stone-400">{kindNames[payment.kind] || 'Payment'}</p></td><td>{shortDate(payment.paidAt)} {dateKey(payment.paidAt).slice(0, 4)}<p className="mt-1 text-[10px] text-stone-400">{time(payment.paidAt)}</p></td><td><span className="badge bg-[#f2f4ee]! text-[#59675c]!">{methodNames[payment.method]}</span></td><td className={`text-right! font-semibold ${reversed ? 'text-stone-400 line-through' : 'text-[#254b38]'}`}>{money(payment.amount)}</td><td className="text-right!">{reversed ? <span className="badge cancelled !text-[9px]" title={payment.reversedReason}>Reversed</span> : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void undo(payment.id)}><Undo2 size={12} />Undo</Button>}</td></tr>; })}</tbody></table></div><PaymentHistoryCards payments={payments} data={data} busy={busy} onUndo={paymentId => void undo(paymentId)} /></> : <Empty title={query ? 'No matching payments' : 'Your payment ledger starts here'} icon={Banknote}>{query ? 'Try a different student name or reference.' : 'Record a payment when a student pays by cash, bank transfer, or another offline method.'}</Empty>}</div> : <div id="payment-outstanding-panel" role="tabpanel" aria-labelledby="payment-outstanding-tab">{outstanding.length ? <><div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Student</th><th>Unpaid item</th><th>Balance</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{outstanding.map(target => <tr key={target.key}><td className="font-medium">{target.studentName}</td><td>{target.label}<p className="mt-1 text-[10px] text-stone-400">{target.packageId ? 'Package purchase' : 'Student class price'}</p></td><td className="font-semibold text-[#254b38]">{money(target.amount)}</td><td className="text-right!"><Button variant="outline" size="sm" onClick={() => setRecord({ target })}>Record payment</Button></td></tr>)}</tbody></table></div><OutstandingCards targets={outstanding} onRecord={target => setRecord({ target })} /></> : <Empty title={query ? 'No matching balances' : 'All caught up'} icon={CircleCheck}>{query ? 'Try a different student name.' : 'There are no unpaid classes or packages to collect.'}</Empty>}</div>}
    </section>
    <p className="mt-4 text-[10px] leading-relaxed text-[#59675c]">Amounts are in SGD. Recorded receipts are not a bank reconciliation. Unallocated payments do not automatically settle class or package balances.</p>
    {record && <PaymentEditor data={data} refresh={refresh} target={record.target} onClose={() => setRecord(undefined)} />}
    {payout && <PayoutEditor data={data} refresh={refresh} onClose={() => setPayout(false)} />}
  </>;
}
