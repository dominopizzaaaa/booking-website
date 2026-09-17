'use client';

import { useState } from 'react';
import { ArrowDownLeft, Banknote, CalendarDays, CreditCard, Package, Search, Wallet, CircleCheck, Clock3, Undo2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { mutate, recordCoachPayout, reversePayment } from '@/lib/api';
import type { Payment, Workspace } from '@/lib/types';
import { addDaysKey, dateKey, money, shortDate, time } from '@/lib/utils';
import { CheckField, Editor, Empty, Field, PageHeading, Stat, cents, numeric, text, type ManagementProps } from './management-ui';

export type PaymentTarget = { key: string; customerId: string; customerName: string; label: string; amount: number; bookingId?: string; packageId?: string };
export function paymentTargets(data: Workspace): PaymentTarget[] {
  return [
    ...data.bookings.filter(b => b.status !== 'CANCELLED').flatMap(booking => booking.participants.filter(p => !p.paid && !p.packageId && p.price > 0).map(p => ({ key: `booking:${booking.id}:${p.id}`, customerId: p.customerId, customerName: p.name, bookingId: booking.id, label: `${booking.serviceName} · ${shortDate(booking.startAt)} · ${time(booking.startAt)}`, amount: p.price }))),
    ...data.packages.filter(p => !p.paid && p.price > 0).map(p => ({ key: `package:${p.id}`, customerId: p.customerId, customerName: p.customerName, packageId: p.id, label: `${p.name} · ${p.totalCredits} credits`, amount: p.price })),
  ];
}

function PaymentHistoryCards({ payments, data }: { payments: Payment[]; data: Workspace }) {
  return <div className="divide-y divide-[#edf0e8] sm:hidden">{payments.map(payment => {
    const booking = data.bookings.find(b => b.id === payment.bookingId);
    const pkg = data.packages.find(p => p.id === payment.packageId);
    const subject = booking?.serviceName || pkg?.name || (payment.bookingId ? 'Lesson payment' : payment.packageId ? 'Package payment' : 'Unallocated payment');
    return <article key={payment.id} className={`p-4 ${payment.reversedAt ? 'opacity-60' : ''}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm text-[#294735]">{payment.kind === 'CLUB_TO_COACH' ? payment.instructorName || payment.customerName : payment.customerName}</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{payment.kind === 'CLUB_TO_COACH' ? 'Coach payout' : subject}</p></div><strong className={`shrink-0 text-sm font-semibold ${payment.reversedAt ? 'text-stone-400 line-through' : 'text-[#254b38]'}`}>{money(payment.amount)}</strong></div><div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-stone-500"><span className="badge bg-[#f2f4ee]! text-[#7c8671]!">{methodNames[payment.method]}</span><span>{kindNames[payment.kind] || 'Payment'}</span><span>{shortDate(payment.paidAt)} · {time(payment.paidAt)}</span>{payment.reversedAt && <span className="badge cancelled !text-[9px]">Reversed</span>}</div>{payment.note && <p className="mt-3 break-words rounded-lg bg-[#f7f8f5] px-3 py-2 text-[10px] leading-relaxed text-stone-500">{payment.note}</p>}</article>;
  })}</div>;
}

function OutstandingCards({ targets, onRecord }: { targets: PaymentTarget[]; onRecord: (target: PaymentTarget) => void }) {
  return <div className="divide-y divide-[#edf0e8] sm:hidden">{targets.map(target => <article key={target.key} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm text-[#294735]">{target.customerName}</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{target.label}</p></div><strong className="shrink-0 text-sm font-semibold text-[#254b38]">{money(target.amount)}</strong></div><div className="mt-4 flex items-center justify-between gap-3"><span className="text-[10px] text-stone-400">{target.packageId ? 'Package purchase' : 'Participant lesson price'}</span><Button variant="outline" size="sm" onClick={() => onRecord(target)}>Record payment</Button></div></article>)}</div>;
}

export function PackageEditor({ data, refresh, onClose, customerId }: ManagementProps & { onClose: () => void; customerId?: string }) {
  const [paid, setPaid] = useState(false);
  return <Editor title="Sell a lesson package" description="Give a customer a set of lesson credits. Credits are deducted when they book, and returned if the booking is cancelled." onClose={onClose} refresh={refresh} success="Lesson package created" submitLabel="Create package" disabled={!data.customers.length} onSubmit={form => {
    const expiry = text(form, 'expiresAt');
    if (expiry < dateKey()) throw new Error('Choose an expiry date today or later.');
    return mutate('/packages', 'POST', { customerId: text(form, 'package-customer'), name: text(form, 'name'), serviceId: text(form, 'package-service') || null, totalCredits: numeric(form, 'totalCredits'), price: cents(text(form, 'price')), expiresAt: new Date(`${expiry}T23:59:59+08:00`).toISOString(), paid });
  }}><div className="form-grid max-sm:grid-cols-1!"><Field label="Customer" name="package-customer" wide><select id="package-customer" name="package-customer" required defaultValue={customerId || ''}><option value="" disabled>Select a customer</option>{data.customers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.email}</option>)}</select>{!data.customers.length && <p className="mt-2 text-xs text-amber-800">Add a customer before selling a package.</p>}</Field><Field label="Package name" name="name" required wide placeholder="e.g. 10-lesson tennis pass" /><Field label="Eligible service" name="package-service" wide><select id="package-service" name="package-service" defaultValue=""><option value="">Any service</option>{data.services.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Lesson credits" name="totalCredits" type="number" required min="1" max="500" step="1" defaultValue="10" /><Field label="Package price (SGD)" name="price" type="number" required min="0" step="0.01" placeholder="700.00" /><Field label="Expiry date" name="expiresAt" type="date" required min={dateKey()} defaultValue={addDaysKey(dateKey(), 180)} wide /></div><CheckField label="Payment already received" checked={paid} onChange={e => setPaid(e.target.checked)} hint="Only select this if you have already received the full package price offline." />{paid && <p className="rounded-lg bg-[#eff3e9] p-3 text-xs leading-relaxed text-[#697d5e]">This records the package as paid. No online charge is made. To choose a payment method and note, leave this off and record the payment from Payments after creating the package.</p>}</Editor>;
}

export function PaymentEditor({ data, refresh, onClose, target: initialTarget, customerId: initialCustomer }: ManagementProps & { onClose: () => void; target?: PaymentTarget; customerId?: string }) {
  const [customerId, setCustomer] = useState(initialTarget?.customerId || initialCustomer || '');
  const [targetKey, setTarget] = useState(initialTarget?.key || '');
  const targets = paymentTargets(data).filter(t => t.customerId === customerId);
  const selected = targets.find(t => t.key === targetKey);
  const other = targetKey === 'other';
  return <Editor title="Record a payment" description="Keep a record of money already received. This does not charge a card, send an invoice, or transfer funds." onClose={onClose} refresh={refresh} success="Payment recorded" submitLabel="Record payment" disabled={!customerId || (!selected && !other)} onSubmit={form => {
    if (!customerId || (!selected && !other)) throw new Error('Choose a customer and what this payment is for.');
    if (initialTarget && !selected && !other) throw new Error('This item may already have been paid. Please refresh and try again.');
    const amount = selected ? selected.amount : cents(text(form, 'amount'));
    if (amount <= 0) throw new Error('The payment amount must be greater than zero.');
    return mutate('/payments', 'POST', { customerId, ...(selected?.bookingId ? { bookingId: selected.bookingId } : {}), ...(selected?.packageId ? { packageId: selected.packageId } : {}), amount, method: text(form, 'payment-method'), note: text(form, 'note') });
  }}><div className="form-grid max-sm:grid-cols-1!"><Field label="Customer" name="payment-customer" wide><select id="payment-customer" value={customerId} required onChange={e => { setCustomer(e.target.value); setTarget(''); }}><option value="" disabled>Select a customer</option>{data.customers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.email}</option>)}</select></Field><Field label="Payment for" name="payment-target" wide><select id="payment-target" required value={targetKey} onChange={e => setTarget(e.target.value)} disabled={!customerId}><option value="" disabled>Select an unpaid item</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label} · {money(target.amount)}</option>)}<option value="other">Other · unallocated payment</option></select></Field>{selected ? <Field label="Exact amount (SGD)" name="amount" type="number" value={(selected.amount / 100).toFixed(2)} readOnly hint="Linked payments settle this customer's full participant price or package price. Partial or extra amounts cannot be recorded against it." /> : <Field key={targetKey} label="Amount received (SGD)" name="amount" type="number" min="0.01" step="0.01" required disabled={!other} placeholder="0.00" />}<Field label="Payment method" name="payment-method"><select id="payment-method" name="payment-method" required defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></Field><Field label={other ? 'What was this payment for?' : 'Reference or note (optional)'} name="payment-note" wide><textarea id="payment-note" name="note" rows={3} required={other} placeholder={other ? 'Describe the reason for this payment' : 'e.g. PayNow reference or receipt number'} /></Field></div>{other && <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">An unallocated payment does not mark a lesson or package as paid. Choose the unpaid item above to settle a balance.</p>}{!data.customers.length && <p className="text-xs text-amber-800">Add a customer first to record a payment.</p>}</Editor>;
}

export function PackagesView({ data, refresh }: ManagementProps) {
  const [create, setCreate] = useState(false);
  const [pay, setPay] = useState<PaymentTarget>();
  const [filter, setFilter] = useState('all');
  const today = dateKey();
  const activePackages = data.packages.filter(p => p.usedCredits < p.totalCredits && dateKey(p.expiresAt) >= today);
  const packages = data.packages.filter(p => filter === 'all' || (filter === 'active' && p.usedCredits < p.totalCredits && dateKey(p.expiresAt) >= today) || (filter === 'unpaid' && !p.paid) || (filter === 'expired' && dateKey(p.expiresAt) < today));
  return <>
    <PageHeading title="Lesson packages" description="More time to grow. Keep track of every customer's credits, payments, and renewals." action={() => setCreate(true)} actionLabel="Sell package" />
    <div className="stat-grid grid-cols-2! sm:grid-cols-3! [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1"><Stat label="Active packages" value={activePackages.length} detail="Unexpired, with credits remaining" icon={Package} /><Stat label="Available credits" value={activePackages.reduce((sum, p) => sum + p.totalCredits - p.usedCredits, 0)} detail="Across all active packages" icon={LayersIcon} /><Stat label="Package balance due" value={money(data.packages.filter(p => !p.paid).reduce((sum, p) => sum + p.price, 0))} detail="Packages not yet marked paid" icon={Wallet} /></div>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e9e0] bg-white p-3 sm:px-4"><p className="text-xs text-stone-500"><strong className="font-semibold text-[#405941]">{packages.length}</strong> package{packages.length === 1 ? '' : 's'}</p><select aria-label="Filter packages" value={filter} onChange={e => setFilter(e.target.value)} className="text-xs max-sm:w-full sm:max-w-44"><option value="all">All packages</option><option value="active">Active packages</option><option value="unpaid">Unpaid packages</option><option value="expired">Expired packages</option></select></div>
    {packages.length ? <div className="cards-grid">{packages.map(p => { const expired = dateKey(p.expiresAt) < today; const remaining = Math.max(0, p.totalCredits - p.usedCredits); return <article key={p.id} className="panel flex flex-col p-5 transition-shadow hover:shadow-sm"><div className="flex items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eff3e8] text-[#83946f]"><Package size={21} strokeWidth={1.5} /></span><span className={`badge ${expired ? 'cancelled' : remaining === 0 ? 'completed' : ''}`}>{expired ? 'Expired' : remaining === 0 ? 'Used up' : 'Active'}</span></div><h2 className="mt-4 text-base text-[#294735]">{p.name}</h2><p className="mt-1 text-xs text-stone-500">{p.customerName}</p><p className="mt-4 text-[10px] text-stone-400">{p.serviceId ? data.services.find(s => s.id === p.serviceId)?.name || 'Assigned service' : 'Any service'}</p><div className="mt-4 flex items-end justify-between gap-2"><p><strong className="text-2xl font-semibold tracking-tight text-[#254b38]">{remaining}</strong><span className="ml-1 text-xs text-stone-500">credits left</span></p><span className="text-[10px] text-stone-400">{p.usedCredits} of {p.totalCredits} used</span></div><div role="progressbar" aria-label={`${p.name} used credits`} aria-valuemin={0} aria-valuemax={p.totalCredits} aria-valuenow={Math.min(p.usedCredits, p.totalCredits)} className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf0e7]"><div className="h-full rounded-full bg-[#66885a]" style={{ width: `${Math.min(100, p.totalCredits ? p.usedCredits / p.totalCredits * 100 : 0)}%` }} /></div><p className="mt-4 flex items-center gap-2 text-[11px] text-stone-500"><CalendarDays size={12} />{expired ? 'Expired' : 'Expires'} {shortDate(p.expiresAt)} {dateKey(p.expiresAt).slice(0, 4)}</p><div className="mt-auto pt-5"><div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#edf0e8] pt-4"><span className="text-base font-semibold text-[#254b38]">{money(p.price)}</span>{p.price === 0 ? <span className="badge">No payment due</span> : p.paid ? <span className="badge"><CircleCheck size={10} />Paid</span> : <Button size="sm" variant="outline" onClick={() => setPay(paymentTargets(data).find(t => t.packageId === p.id))}>Record payment</Button>}</div></div></article>; })}</div> : <div className="panel"><Empty title="A little commitment, a lot of progress" icon={Package}>No packages match this view. Sell a package to offer customers a bundle of lesson credits.</Empty></div>}
    {create && <PackageEditor data={data} refresh={refresh} onClose={() => setCreate(false)} />}{pay && <PaymentEditor data={data} refresh={refresh} target={pay} onClose={() => setPay(undefined)} />}
  </>;
}

const LayersIcon = CreditCard;
const methodNames: Record<string, string> = { BANK_TRANSFER: 'Bank transfer', CASH: 'Cash', OTHER: 'Other' };
const kindNames: Record<string, string> = {
  CUSTOMER_TO_CLUB: 'Student → club',
  CUSTOMER_TO_COACH: 'Student → coach',
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
  return <Editor
    title="Record a coach payout"
    description="Money your club has paid a coach for lessons already taught. This does not transfer funds; it records what you have paid."
    onClose={onClose}
    refresh={refresh}
    success="Coach payout recorded"
    submitLabel="Record payout"
    disabled={!data.instructors.length}
    onSubmit={form => recordCoachPayout({
      instructorId: text(form, 'payout-instructor'),
      amount: cents(text(form, 'amount')),
      method: text(form, 'payout-method'),
      note: text(form, 'note'),
    })}
  >
    <div className="form-grid max-sm:grid-cols-1!">
      <Field label="Coach" name="payout-instructor" wide><select id="payout-instructor" name="payout-instructor" required defaultValue=""><option value="" disabled>Select a coach</option>{data.instructors.filter(instructor => instructor.active).map(instructor => <option key={instructor.id} value={instructor.id}>{instructor.name}</option>)}</select></Field>
      <Field label="Amount paid (SGD)" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" />
      <Field label="Payment method" name="payout-method"><select id="payout-method" name="payout-method" required defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer / PayNow</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></Field>
      <Field label="Reference or period (optional)" name="payout-note" wide><textarea id="payout-note" name="note" rows={2} placeholder="e.g. March lessons, 12 sessions" /></Field>
    </div>
  </Editor>;
}
export function PaymentsView({ data, refresh }: ManagementProps) {
  const [record, setRecord] = useState<{ target?: PaymentTarget }>();
  const [payout, setPayout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('history');
  const [query, setQuery] = useState('');
  const targets = paymentTargets(data);
  const month = dateKey().slice(0, 7);
  const isClub = data.business.kind !== 'SOLO';
  // A reversed payment stays in the ledger for the audit trail but counts
  // towards nothing, so every total here filters it out.
  const live = data.payments.filter(payment => !payment.reversedAt);
  const collected = live.filter(payment => payment.kind !== 'CLUB_TO_COACH');
  const paidOut = live.filter(payment => payment.kind === 'CLUB_TO_COACH');
  const payments = [...data.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt)).filter(p => `${p.customerName} ${p.instructorName ?? ''} ${p.note} ${methodNames[p.method]}`.toLowerCase().includes(query.toLowerCase()));
  const outstanding = targets.filter(t => `${t.customerName} ${t.label}`.toLowerCase().includes(query.toLowerCase()));

  async function undo(paymentId: string) {
    const reason = window.prompt('Reverse this payment? Say briefly why, for the ledger.', 'Recorded by mistake');
    if (reason === null) return;
    setBusy(true);
    try { await reversePayment(paymentId, reason); await refresh(); toast.success('Payment reversed'); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading title="Payments" description={isClub ? 'Money the club collects from students, and what it pays its coaches. Recorded by hand; nothing is charged or transferred here.' : 'A clear picture of money in and balances due. Record the payments you receive offline.'} action={() => setRecord({})} actionLabel="Record payment" />
    <div className="stat-grid"><Stat label="Recorded this month" value={money(collected.filter(p => dateKey(p.paidAt).startsWith(month)).reduce((sum, p) => sum + p.amount, 0))} detail="Based on the date payments were recorded" icon={ArrowDownLeft} /><Stat label="Collected from students" value={money(collected.reduce((sum, p) => sum + p.amount, 0))} detail={`${collected.length} payment records · all time`} icon={Banknote} />{isClub ? <Stat label="Paid to coaches" value={money(paidOut.reduce((sum, p) => sum + p.amount, 0))} detail={`${paidOut.length} payout${paidOut.length === 1 ? '' : 's'} recorded`} icon={Wallet} /> : <Stat label="Outstanding" value={money(targets.reduce((sum, t) => sum + t.amount, 0))} detail="Unpaid lessons and packages" icon={Wallet} />}<Stat label="Items awaiting payment" value={targets.length} detail="Cancelled lessons are excluded" icon={Clock3} /></div>
    {isClub && <div className="mb-5 flex flex-col gap-3 rounded-xl border border-[#e3e9db] bg-[#f4f7ef] p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2.5 text-xs leading-relaxed text-[#66755f]"><ShieldCheck size={16} className="mt-0.5 shrink-0" />Lessons booked through {data.business.name} are paid to the club. Record what you then pay each coach so both sides of the ledger stay complete.</p>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPayout(true)}><Wallet size={13} />Record coach payout</Button>
    </div>}
    <section className="panel overflow-hidden" aria-label="Payment records">
      <div className="panel-heading flex-wrap border-b border-[#edf0e8]"><div className="tab-bar w-full sm:w-auto" role="tablist" aria-label="Payments view"><button id="payment-history-tab" role="tab" aria-selected={tab === 'history'} aria-controls="payment-history-panel" className={`flex-1 sm:flex-none ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>Payment history</button><button id="payment-outstanding-tab" role="tab" aria-selected={tab === 'outstanding'} aria-controls="payment-outstanding-panel" className={`flex-1 sm:flex-none ${tab === 'outstanding' ? 'active' : ''}`} onClick={() => setTab('outstanding')}>Outstanding ({targets.length})</button></div><div className="relative w-full sm:max-w-72"><Search size={14} className="pointer-events-none absolute top-3.5 left-3 text-stone-400" /><input className="pl-9! text-xs!" type="search" aria-label="Search payments" placeholder="Search customer or reference…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
      {tab === 'history' ? <div id="payment-history-panel" role="tabpanel" aria-labelledby="payment-history-tab">{payments.length ? <><div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Customer</th><th>Payment for</th><th>Received</th><th>Method</th><th className="text-right!">Amount</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{payments.map(payment => { const booking = data.bookings.find(b => b.id === payment.bookingId); const pkg = data.packages.find(p => p.id === payment.packageId); const reversed = !!payment.reversedAt; return <tr key={payment.id} className={reversed ? 'opacity-60' : undefined}><td><p className="font-medium">{payment.kind === 'CLUB_TO_COACH' ? payment.instructorName || payment.customerName : payment.customerName}</p><p className="mt-1 max-w-52 truncate text-[10px] text-stone-400" title={payment.note}>{payment.note || 'No reference'}</p></td><td>{payment.kind === 'CLUB_TO_COACH' ? 'Coach payout' : booking?.serviceName || pkg?.name || (payment.bookingId ? 'Lesson payment' : payment.packageId ? 'Package payment' : 'Unallocated payment')}<p className="mt-1 text-[10px] text-stone-400">{kindNames[payment.kind] || 'Payment'}</p></td><td>{shortDate(payment.paidAt)} {dateKey(payment.paidAt).slice(0, 4)}<p className="mt-1 text-[10px] text-stone-400">{time(payment.paidAt)}</p></td><td><span className="badge bg-[#f2f4ee]! text-[#7c8671]!">{methodNames[payment.method]}</span></td><td className={`text-right! font-semibold ${reversed ? 'text-stone-400 line-through' : 'text-[#254b38]'}`}>{money(payment.amount)}</td><td className="text-right!">{reversed ? <span className="badge cancelled !text-[9px]" title={payment.reversedReason}>Reversed</span> : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void undo(payment.id)}><Undo2 size={12} />Undo</Button>}</td></tr>; })}</tbody></table></div><PaymentHistoryCards payments={payments} data={data} /></> : <Empty title={query ? 'No matching payments' : 'Your payment ledger starts here'} icon={Banknote}>{query ? 'Try a different customer name or reference.' : 'Record a payment when a customer pays by cash, bank transfer, or another offline method.'}</Empty>}</div> : <div id="payment-outstanding-panel" role="tabpanel" aria-labelledby="payment-outstanding-tab">{outstanding.length ? <><div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Customer</th><th>Unpaid item</th><th>Balance</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{outstanding.map(target => <tr key={target.key}><td className="font-medium">{target.customerName}</td><td>{target.label}<p className="mt-1 text-[10px] text-stone-400">{target.packageId ? 'Package purchase' : 'Participant lesson price'}</p></td><td className="font-semibold text-[#254b38]">{money(target.amount)}</td><td className="text-right!"><Button variant="outline" size="sm" onClick={() => setRecord({ target })}>Record payment</Button></td></tr>)}</tbody></table></div><OutstandingCards targets={outstanding} onRecord={target => setRecord({ target })} /></> : <Empty title={query ? 'No matching balances' : 'All caught up'} icon={CircleCheck}>{query ? 'Try a different customer name.' : 'There are no unpaid lessons or packages to collect.'}</Empty>}</div>}
    </section>
    <p className="mt-4 text-[10px] leading-relaxed text-stone-400">Amounts are in SGD. Recorded receipts are not a bank reconciliation. Unallocated payments do not automatically settle lesson or package balances.</p>
    {record && <PaymentEditor data={data} refresh={refresh} target={record.target} onClose={() => setRecord(undefined)} />}
    {payout && <PayoutEditor data={data} refresh={refresh} onClose={() => setPayout(false)} />}
  </>;
}
