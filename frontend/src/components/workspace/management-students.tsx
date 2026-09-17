'use client';

import { useState } from 'react';
import { ArrowUpRight, CalendarDays, Mail, Package, Pencil, Phone, Search, UserRound, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { mutate } from '@/lib/api';
import { isManagerWorkspace, type ManagerWorkspace, type Student } from '@/lib/types';
import { dateKey, initials, money, shortDate, time } from '@/lib/utils';
import { Editor, Empty, Field, PageHeading, text, type ManagementProps, type WorkspaceProps } from './management-ui';
import { PackageEditor, PaymentEditor, paymentTargets } from './management-finance';

export function StudentsView({ data, refresh }: WorkspaceProps) {
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState<string>();
  const [editing, setEditing] = useState<Student | null | undefined>();
  const [sellTo, setSellTo] = useState<string>();
  const [payFor, setPayFor] = useState<string>();
  const filtered = data.students.filter(student => `${student.name} ${student.email} ${student.phone} ${student.parentName}`.toLowerCase().includes(query.toLowerCase()));
  const current = data.students.find(student => student.id === profile);
  const managerData = isManagerWorkspace(data) ? data : null;
  const canManage = managerData !== null;

  function creditBalance(studentId: string) {
    return managerData?.packages
      .filter(pkg => pkg.studentId === studentId && dateKey(pkg.expiresAt) >= dateKey())
      .reduce((sum, pkg) => sum + Math.max(0, pkg.totalCredits - pkg.usedCredits), 0) ?? 0;
  }

  return <>
    <PageHeading title="Students" description="The people at the heart of your business. Remember the details that make a lesson personal." action={canManage ? () => setEditing(null) : undefined} actionLabel="Add student" />
    <section className="panel overflow-hidden" aria-labelledby="student-directory-title">
      <div className="panel-heading flex-wrap border-b border-[#edf0e8]">
        <div className="flex items-center gap-2"><Users size={17} className="text-[#8b9a7b]" /><h2 id="student-directory-title">Student directory</h2><span className="badge">{data.students.length}</span></div>
        <div className="relative w-full sm:max-w-80"><Search size={14} className="pointer-events-none absolute left-3 top-3.5 text-stone-400" /><input type="search" aria-label="Search students by name, email, phone, or parent" placeholder="Search name, email, or phone…" value={query} onChange={event => setQuery(event.target.value)} className="pl-9! text-xs!" /></div>
      </div>
      {filtered.length ? <>
        <div className="table-wrap max-sm:hidden">
          <table className="data-table"><thead><tr><th>Student</th><th>Contact</th><th>Bookings</th><th>Latest scheduled</th>{canManage && <th>Credits left</th>}<th><span className="sr-only">View profile</span></th></tr></thead><tbody>{filtered.map(student => {
            const credits = creditBalance(student.id);
            return <tr key={student.id} className="transition-colors hover:bg-[#fafcf7]"><td><button className="flex items-center gap-3 text-left" onClick={() => setProfile(student.id)} aria-label={`View ${student.name}'s profile`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ecf1e4] text-[10px] font-semibold text-[#7c8c63]">{student.initials || initials(student.name)}</span><span><span className="block font-medium">{student.name}</span>{student.parentName && <span className="mt-1 block text-[10px] text-stone-400">Parent: {student.parentName}</span>}</span></button></td><td><p>{student.email}</p><p className="mt-1 text-[10px] text-stone-400">{student.phone || 'No phone added'}</p></td><td>{student.bookingCount}</td><td>{student.lastBookingAt ? shortDate(student.lastBookingAt) : 'No bookings yet'}</td>{canManage && <td>{credits ? <span className="badge">{credits} credits</span> : <span className="text-stone-400">—</span>}</td>}<td><Button variant="ghost" size="icon" onClick={() => setProfile(student.id)} aria-label={`View ${student.name}'s profile`}><ArrowUpRight size={14} /></Button></td></tr>;
          })}</tbody></table>
        </div>
        <div className="divide-y divide-[#edf0e8] sm:hidden">
          {filtered.map(student => {
            const credits = creditBalance(student.id);
            return <button key={student.id} type="button" onClick={() => setProfile(student.id)} className="flex w-full items-start gap-3 p-4 text-left transition-colors active:bg-[#f6f8f2]" aria-label={`View ${student.name}'s profile`}><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ecf1e4] text-xs font-semibold text-[#7c8c63]">{student.initials || initials(student.name)}</span><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-[#294735]">{student.name}</span><span className="mt-1 block truncate text-[11px] text-stone-500">{student.email}</span></span><ArrowUpRight size={15} className="mt-0.5 shrink-0 text-stone-400" /></span><span className="mt-3 flex flex-wrap gap-2 text-[10px] text-stone-500"><span className="rounded-full bg-[#f4f6f1] px-2 py-1">{student.bookingCount} booking{student.bookingCount === 1 ? '' : 's'}</span>{canManage && credits > 0 && <span className="rounded-full bg-[#edf2e8] px-2 py-1 text-[#647e56]">{credits} credits</span>}<span className="rounded-full bg-[#f4f6f1] px-2 py-1">{student.lastBookingAt ? shortDate(student.lastBookingAt) : 'No lessons yet'}</span></span></span></button>;
          })}
        </div>
      </> : <Empty title={query ? 'No students found' : 'Your next regular starts here'} icon={Users}>{query ? 'Try another name, email, phone number, or parent name.' : 'Connect a player who has already created their own Courtly student account.'}</Empty>}
    </section>
    {current && <StudentProfile student={current} data={data} onClose={() => setProfile(undefined)} onEdit={() => { setEditing(current); setProfile(undefined); }} onPackage={() => { setSellTo(current.id); setProfile(undefined); }} onPayment={() => { setPayFor(current.id); setProfile(undefined); }} />}
    {managerData && editing !== undefined && <StudentEditor student={editing} data={managerData} refresh={refresh} onClose={() => setEditing(undefined)} />}
    {managerData && sellTo && <PackageEditor data={managerData} refresh={refresh} studentId={sellTo} onClose={() => setSellTo(undefined)} />}
    {managerData && payFor && <PaymentEditor data={managerData} refresh={refresh} studentId={payFor} onClose={() => setPayFor(undefined)} />}
  </>;
}

function StudentEditor({ student, refresh, onClose }: ManagementProps & { student: Student | null; onClose: () => void }) {
  const linked = student?.userId != null;
  const description = linked
    ? 'Name and contact details come from the student’s Courtly account. Internal notes stay private to your team.'
    : student
      ? 'Keep this historical student record and its lesson preferences up to date. Internal notes stay private to your team.'
      : 'Enter the email used for an existing registered Courtly student account. Their profile details come from that account.';
  return <Editor title={student ? 'Edit student' : 'Connect a student account'} description={description} onClose={onClose} refresh={refresh} success={student ? 'Student saved' : 'Student account connected'} submitLabel={student ? 'Save student' : 'Connect student'} onSubmit={form => mutate(`/students${student ? `/${student.id}` : ''}`, student ? 'PATCH' : 'POST', linked ? { notes: text(form, 'notes') } : student ? { name: text(form, 'name'), email: text(form, 'email'), phone: text(form, 'phone'), parentName: text(form, 'parentName'), notes: text(form, 'notes') } : { email: text(form, 'email'), notes: text(form, 'notes') })}><div className="form-grid max-sm:grid-cols-1!">{linked ? <div className="field-wide rounded-xl border border-[#e1e7dc] bg-[#fafbf8] p-4 text-xs text-stone-500"><p className="font-medium text-[#344b39]">{student.name}</p><p className="mt-1 break-all">{student.email}</p><p className="mt-1">{student.phone || 'No phone added'}{student.parentName ? ` · Parent / guardian: ${student.parentName}` : ''}</p><p className="mt-3 text-[11px] leading-relaxed">The student manages these details from their account profile.</p></div> : student ? <><Field label="Student name" name="name" defaultValue={student.name} required wide /><Field label="Email" name="email" type="email" defaultValue={student.email} required /><Field label="Phone (optional)" name="phone" type="tel" defaultValue={student.phone} placeholder="+65" /><Field label="Parent or guardian (optional)" name="parentName" defaultValue={student.parentName} wide /></> : <Field label="Registered student account email" name="email" type="email" required wide hint="Must exactly match an existing Courtly student account." />}<Field label="Internal notes" name="student-notes" wide><textarea id="student-notes" name="notes" rows={4} defaultValue={student?.notes} placeholder="Goals, skill level, preferences, or anything useful before the lesson" /></Field></div></Editor>;
}

function ParticipantFinancialSummary({ data, bookingId, studentId }: { data: ManagerWorkspace; bookingId: string; studentId: string }) {
  const participant = data.bookings.find(booking => booking.id === bookingId)?.participants.find(item => item.studentId === studentId);
  if (!participant) return null;
  return <><span>·</span><span>{participant.packageId ? 'Package credit' : participant.paid ? `${money(participant.price)} paid` : `${money(participant.price)} unpaid`}</span></>;
}

function StudentProfile({ student, data, onClose, onEdit, onPackage, onPayment }: Omit<WorkspaceProps, 'refresh'> & { student: Student; onClose: () => void; onEdit: () => void; onPackage: () => void; onPayment: () => void }) {
  const [tab, setTab] = useState('history');
  const managerData = isManagerWorkspace(data) ? data : null;
  const bookings = data.bookings.filter(booking => booking.participants.some(participant => participant.studentId === student.id)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const packages = managerData ? managerData.packages.filter(pkg => pkg.studentId === student.id) : [];
  const outstanding = managerData ? paymentTargets(managerData).filter(target => target.studentId === student.id).reduce((sum, target) => sum + target.amount, 0) : 0;
  const payments = managerData ? managerData.payments.filter(payment => payment.studentId === student.id && !payment.reversedAt) : [];

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl p-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:w-full max-sm:translate-y-0 max-sm:rounded-b-none"><div className="px-5 py-5 sm:px-6 sm:py-6"><div className="flex items-center gap-4 pr-6"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#eaf0df] text-lg font-medium text-[#7b8f5e]">{student.initials || initials(student.name)}</span><div className="min-w-0"><DialogTitle className="truncate text-xl font-semibold tracking-tight text-[#173f2f]">{student.name}</DialogTitle><DialogDescription className="mt-1 text-xs text-stone-500">Student since {shortDate(student.createdAt)} {dateKey(student.createdAt).slice(0, 4)}</DialogDescription></div></div><div className="mt-5 grid gap-2 text-xs text-stone-500 sm:grid-cols-2"><p className="flex items-center gap-2 break-all"><Mail size={13} className="shrink-0" />{student.email}</p><p className="flex items-center gap-2"><Phone size={13} className="shrink-0" />{student.phone || 'No phone added'}</p>{student.parentName && <p className="flex items-center gap-2 sm:col-span-2"><UserRound size={13} className="shrink-0" />Parent / guardian: {student.parentName}</p>}</div><dl className={`my-5 grid gap-2 rounded-xl bg-[#f4f7ef] p-3 sm:gap-3 sm:p-4 ${managerData ? 'grid-cols-3' : 'grid-cols-1'}`}><div className="min-w-0"><dt className="text-[9px] leading-tight text-stone-500 sm:text-[10px]">Bookings</dt><dd className="mt-1 text-lg font-semibold text-[#254b38] sm:text-xl">{student.bookingCount}</dd></div>{managerData && <><div className="min-w-0"><dt className="text-[9px] leading-tight text-stone-500 sm:text-[10px]">Payments recorded</dt><dd className="mt-1 break-words text-sm font-semibold text-[#254b38] sm:text-xl">{money(payments.reduce((sum, payment) => sum + payment.amount, 0))}</dd></div><div className="min-w-0"><dt className="text-[9px] leading-tight text-stone-500 sm:text-[10px]">Balance due</dt><dd className="mt-1 break-words text-sm font-semibold text-[#254b38] sm:text-xl">{money(outstanding)}</dd></div></>}</dl>{managerData && <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap"><Button size="sm" variant="outline" onClick={onEdit}><Pencil size={13} />{student.userId ? 'Edit internal notes' : 'Edit profile & notes'}</Button><Button size="sm" variant="outline" onClick={onPackage}><Package size={13} />Sell package</Button><Button size="sm" variant="outline" onClick={onPayment}><Wallet size={13} />Record payment</Button></div>}<section className="mt-5 rounded-xl border border-[#e6eae3] bg-[#fbfcfa] p-4" aria-labelledby="student-notes-title"><h3 id="student-notes-title" className="text-xs text-[#344b39]">Internal notes</h3><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{student.notes || 'No notes yet. Add goals or preferences to make their next lesson feel personal.'}</p></section><div className="tab-bar my-5 w-full" role="tablist" aria-label="Student records"><button id="student-history-tab" role="tab" aria-selected={tab === 'history'} aria-controls="student-history-panel" className={`flex-1 ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>Lesson history ({bookings.length})</button>{managerData && <button id="student-packages-tab" role="tab" aria-selected={tab === 'packages'} aria-controls="student-packages-panel" className={`flex-1 ${tab === 'packages' ? 'active' : ''}`} onClick={() => setTab('packages')}>Packages ({packages.length})</button>}</div>{tab === 'history' || !managerData ? <div id="student-history-panel" role="tabpanel" aria-labelledby="student-history-tab">{bookings.length ? <div className="max-h-80 space-y-3 overflow-y-auto pr-1">{bookings.map(booking => { const participant = booking.participants.find(item => item.studentId === student.id)!; return <article key={booking.id} className="rounded-xl border border-[#e6eae3] p-3"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-xs text-[#344b39]">{booking.serviceName}</h3><span className={`badge ${booking.status.toLowerCase()}`}>{booking.status.toLowerCase()}</span></div><p className="mt-2 text-[11px] text-stone-500">{shortDate(booking.startAt)} · {time(booking.startAt)} · {booking.locationName}</p><div className="mt-2 flex flex-wrap gap-2 text-[10px] text-stone-400"><span>{booking.instructorName}</span><span>·</span><span>{participant.attendance === 'PRESENT' ? 'Attended' : participant.attendance === 'ABSENT' ? 'Absent' : 'Attendance not marked'}</span>{managerData && <ParticipantFinancialSummary data={managerData} bookingId={booking.id} studentId={student.id} />}</div></article>; })}</div> : <Empty title="No lessons yet" icon={CalendarDays}>Bookings will appear here once this student joins a lesson.</Empty>}</div> : <div id="student-packages-panel" role="tabpanel" aria-labelledby="student-packages-tab">{packages.length ? <div className="space-y-3">{packages.map(pkg => <article key={pkg.id} className="rounded-xl border border-[#e6eae3] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs text-[#344b39]">{pkg.name}</h3><span className={`badge ${dateKey(pkg.expiresAt) < dateKey() ? 'cancelled' : ''}`}>{dateKey(pkg.expiresAt) < dateKey() ? 'Expired' : `${Math.max(0, pkg.totalCredits - pkg.usedCredits)} credits left`}</span></div><p className="mt-2 text-[11px] text-stone-500">{pkg.usedCredits} of {pkg.totalCredits} used · {money(pkg.price)} · {pkg.paid ? 'Paid' : 'Unpaid'}</p><p className="mt-1 text-[10px] text-stone-400">Expires {shortDate(pkg.expiresAt)} {dateKey(pkg.expiresAt).slice(0, 4)}</p></article>)}</div> : <Empty title="A fresh set of credits awaits" icon={Package}>Sell a package to give this student a bundle of lessons.</Empty>}</div>}</div></DialogContent></Dialog>;
}
