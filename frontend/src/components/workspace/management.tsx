'use client';

import { useState } from 'react';
import { Banknote, CalendarCheck2, CircleCheck, TrendingUp, Users } from 'lucide-react';
import type { Workspace } from '@/lib/types';
import { addDaysKey, dateKey, money, shortDate } from '@/lib/utils';
import { LocationsView, ServicesView, TeamView } from './management-catalog';
import { CustomersView } from './management-customers';
import { PackagesView, PaymentsView } from './management-finance';
import { AvailabilityView, SettingsView } from './management-operations';
import { Empty, PageHeading, Stat, type ManagementProps } from './management-ui';

export function ManagementView({ view, data, refresh }: { view: string; data: Workspace; refresh: () => Promise<void> }) {
  const props = { data, refresh };
  if (data.user.role === 'COACH' && !['customers', 'availability'].includes(view)) return <div className="panel"><Empty title="Owner or administrator access required">Your account can view assigned customers and availability. Business management and financial records are restricted.</Empty></div>;
  switch (view) {
    case 'services': return <ServicesView {...props} />;
    case 'locations': return <LocationsView {...props} />;
    case 'customers': return <CustomersView {...props} />;
    case 'packages': return <PackagesView {...props} />;
    case 'payments': return <PaymentsView {...props} />;
    case 'team': return <TeamView {...props} />;
    case 'settings': return <SettingsView {...props} />;
    case 'availability': return <AvailabilityView {...props} />;
    case 'insights': return <InsightsView {...props} />;
    default: return <div className="panel"><Empty title="Choose a workspace page">Use the navigation to open your schedule, customers, or business settings.</Empty></div>;
  }
}

function InsightsView({ data }: ManagementProps) {
  const [weekCount, setWeekCount] = useState(8);
  const today = dateKey();
  const dayOfWeek = new Date(`${today}T12:00:00+08:00`).getUTCDay();
  const thisMonday = addDaysKey(today, -((dayOfWeek + 6) % 7));
  const weeks = Array.from({ length: weekCount }, (_, index) => {
    const start = addDaysKey(thisMonday, (index - weekCount + 1) * 7);
    const end = addDaysKey(start, 7);
    const payments = data.payments.filter(p => dateKey(p.paidAt) >= start && dateKey(p.paidAt) < end);
    const bookings = data.bookings.filter(b => b.status !== 'CANCELLED' && dateKey(b.startAt) >= start && dateKey(b.startAt) < end && new Date(b.endAt).getTime() <= Date.now());
    const participants = bookings.flatMap(b => b.participants);
    return { start, end, revenue: payments.reduce((sum, p) => sum + p.amount, 0), sessions: bookings.length, present: participants.filter(p => p.attendance === 'PRESENT').length, absent: participants.filter(p => p.attendance === 'ABSENT').length, unmarked: participants.filter(p => p.attendance === 'UNMARKED').length };
  });
  const periodStart = weeks[0].start;
  const periodBookings = data.bookings.filter(b => b.status !== 'CANCELLED' && dateKey(b.startAt) >= periodStart && dateKey(b.startAt) <= today && new Date(b.endAt).getTime() <= Date.now());
  const revenue = weeks.reduce((sum, week) => sum + week.revenue, 0);
  const attended = weeks.reduce((sum, week) => sum + week.present, 0);
  const absent = weeks.reduce((sum, week) => sum + week.absent, 0);
  const unmarked = weeks.reduce((sum, week) => sum + week.unmarked, 0);
  const recorded = attended + absent;
  const maxRevenue = Math.max(1, ...weeks.map(w => w.revenue));
  const maxAttendance = Math.max(1, ...weeks.map(w => w.present + w.absent + w.unmarked));
  const services = data.services.map(service => {
    const bookings = periodBookings.filter(b => b.serviceId === service.id);
    const participants = bookings.flatMap(b => b.participants);
    const bookingIds = new Set(bookings.map(b => b.id));
    const linkedPayments = data.payments.filter(p => p.bookingId && bookingIds.has(p.bookingId));
    return { ...service, count: bookings.length, participants: participants.length, present: participants.filter(p => p.attendance === 'PRESENT').length, received: linkedPayments.reduce((sum, p) => sum + p.amount, 0) };
  }).filter(s => s.count > 0).sort((a, b) => b.count - a.count);
  const reversedWeeks = [...weeks].reverse();
  return <>
    <PageHeading title="Insights" description="A quieter look at the bigger picture. Real lessons, real attendance, and the payments you have recorded." />
    <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e9e0] bg-white p-3 sm:px-4">
      <p className="text-xs text-stone-500">{shortDate(periodStart + 'T12:00:00+08:00')} – {shortDate(today + 'T12:00:00+08:00')} <span className="text-stone-400">· Singapore time</span></p>
      <select aria-label="Insights reporting period" value={weekCount} onChange={e => setWeekCount(Number(e.target.value))} className="text-xs max-sm:w-full sm:max-w-44"><option value="4">Last 4 weeks</option><option value="8">Last 8 weeks</option><option value="12">Last 12 weeks</option></select>
    </div>
    <div className="stat-grid"><Stat label="Recorded receipts" value={money(revenue)} detail="Payment records dated in this period" icon={Banknote} /><Stat label="Elapsed lessons" value={periodBookings.length} detail="Non-cancelled lessons that have ended" icon={CalendarCheck2} /><Stat label="Attendance rate" value={recorded ? `${Math.round(attended / recorded * 100)}%` : '—'} detail={recorded ? `${attended} present of ${recorded} marked participants` : 'No attendance has been marked'} icon={CircleCheck} /><Stat label="Customers taught" value={new Set(periodBookings.flatMap(b => b.participants.filter(p => p.attendance === 'PRESENT').map(p => p.customerId))).size} detail="Unique customers marked present" icon={Users} /></div>
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="panel overflow-hidden">
        <div className="panel-heading"><div><h2 className="text-[#294735]">Weekly receipts</h2><p className="mt-1 text-[11px] text-stone-500">Recorded payments · SGD</p></div><TrendingUp size={17} className="text-[#94a37f]" /></div>
        <div className="overflow-x-auto px-4 pb-5 sm:px-5"><div className="min-w-[390px] sm:min-w-0"><div className="flex h-52 items-stretch gap-2" role="img" aria-label={`Weekly recorded receipts total ${money(revenue)}. Exact amounts are in the weekly summary below.`}>{weeks.map((week, index) => <div key={week.start} className="flex min-w-0 flex-1 flex-col justify-end text-center"><span className="mb-2 truncate text-[9px] text-stone-500" title={money(week.revenue)}>{money(week.revenue)}</span><div className="flex h-36 items-end justify-center rounded-t-md bg-[#fafbf8]"><div title={`${shortDate(week.start + 'T12:00:00+08:00')}: ${money(week.revenue)}`} className={`w-full max-w-12 rounded-t-md ${index === weeks.length - 1 ? 'bg-[#52764b]' : 'bg-[#dbe5cf]'}`} style={{ height: `${week.revenue ? Math.max(2, week.revenue / maxRevenue * 100) : 0}%` }} /></div><span className="mt-2 text-[9px] text-stone-400">{week.start.slice(8)}/{week.start.slice(5, 7)}</span></div>)}</div></div><p className="mt-4 text-[10px] leading-relaxed text-stone-400">Weeks start on Monday. The current week is incomplete. Receipts include packages and unallocated payments; they are not recognised lesson revenue.</p></div>
      </section>
      <section className="panel overflow-hidden">
        <div className="panel-heading"><div><h2 className="text-[#294735]">Weekly attendance</h2><p className="mt-1 text-[11px] text-stone-500">Participants in elapsed, non-cancelled lessons</p></div></div>
        <div className="overflow-x-auto px-4 pb-5 sm:px-5"><div className="min-w-[390px] sm:min-w-0"><div className="flex h-52 items-stretch gap-2" role="img" aria-label={`Attendance: ${attended} present, ${absent} absent, ${unmarked} unmarked. Exact counts are in the weekly summary below.`}>{weeks.map(week => <div key={week.start} className="flex min-w-0 flex-1 flex-col justify-end text-center"><span className="mb-2 text-[9px] text-stone-500">{week.present + week.absent + week.unmarked}</span><div className="flex h-36 items-end justify-center rounded-t-md bg-[#fafbf8]"><div className="flex w-full max-w-12 flex-col-reverse overflow-hidden rounded-t-md" style={{ height: `${(week.present + week.absent + week.unmarked) / maxAttendance * 100}%` }}>{week.present > 0 && <div className="bg-[#779667]" style={{ flex: week.present }} />}{week.absent > 0 && <div className="bg-[#c6ab80]" style={{ flex: week.absent }} />}{week.unmarked > 0 && <div className="bg-[#e6eae1]" style={{ flex: week.unmarked }} />}</div></div><span className="mt-2 text-[9px] text-stone-400">{week.start.slice(8)}/{week.start.slice(5, 7)}</span></div>)}</div></div><div className="mt-4 flex flex-wrap gap-4 text-[10px] text-stone-500"><span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-sm bg-[#779667]" />Present</span><span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-sm bg-[#c6ab80]" />Absent</span><span className="flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-sm bg-[#e6eae1]" />Unmarked ({unmarked})</span></div><p className="mt-3 text-[10px] leading-relaxed text-stone-400">The attendance rate excludes unmarked participants. Future lessons and cancellations are excluded from this chart.</p></div>
      </section>
    </div>
    <section className="panel mt-5 overflow-hidden">
      <div className="panel-heading flex-wrap"><h2 className="text-[#294735]">Weekly summary</h2><span className="text-[10px] text-stone-400">Exact values behind the charts</span></div>
      <div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Week beginning</th><th>Receipts</th><th>Elapsed lessons</th><th>Present</th><th>Absent</th><th>Unmarked</th></tr></thead><tbody>{reversedWeeks.map(week => <tr key={week.start}><td>{shortDate(week.start + 'T12:00:00+08:00')}{week.start === thisMonday && <span className="ml-2 text-[9px] text-stone-400">In progress</span>}</td><td className="font-medium text-[#254b38]">{money(week.revenue)}</td><td>{week.sessions}</td><td>{week.present}</td><td>{week.absent}</td><td className="text-stone-400">{week.unmarked}</td></tr>)}</tbody></table></div>
      <div className="divide-y divide-[#edf0e8] sm:hidden">{reversedWeeks.map(week => <article key={week.start} className="p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-xs text-[#344b39]">Week of {shortDate(week.start + 'T12:00:00+08:00')}</h3>{week.start === thisMonday && <p className="mt-1 text-[10px] text-stone-400">In progress</p>}</div><strong className="text-sm text-[#254b38]">{money(week.revenue)}</strong></div><dl className="mt-3 grid grid-cols-4 gap-2 text-center"><div className="rounded-lg bg-[#f7f8f5] p-2"><dt className="text-[9px] text-stone-400">Lessons</dt><dd className="mt-1 text-xs font-semibold">{week.sessions}</dd></div><div className="rounded-lg bg-[#f1f5ed] p-2"><dt className="text-[9px] text-stone-400">Present</dt><dd className="mt-1 text-xs font-semibold">{week.present}</dd></div><div className="rounded-lg bg-[#faf6ed] p-2"><dt className="text-[9px] text-stone-400">Absent</dt><dd className="mt-1 text-xs font-semibold">{week.absent}</dd></div><div className="rounded-lg bg-[#f7f8f5] p-2"><dt className="text-[9px] text-stone-400">Unmarked</dt><dd className="mt-1 text-xs font-semibold">{week.unmarked}</dd></div></dl></article>)}</div>
    </section>
    <section className="panel mt-5 overflow-hidden">
      <div className="panel-heading"><div><h2 className="text-[#294735]">Lessons by service</h2><p className="mt-1 text-[11px] text-stone-500">Elapsed, non-cancelled sessions within the selected period</p></div></div>
      {services.length ? <><div className="table-wrap max-sm:hidden"><table className="data-table"><thead><tr><th>Service</th><th>Lessons</th><th>Participants</th><th>Marked present</th><th>Linked receipts</th></tr></thead><tbody>{services.map(service => <tr key={service.id}><td><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: service.color }} />{service.name}</td><td>{service.count}</td><td>{service.participants}</td><td>{service.present}</td><td className="font-medium text-[#254b38]">{money(service.received)}</td></tr>)}</tbody></table></div><div className="divide-y divide-[#edf0e8] sm:hidden">{services.map(service => <article key={service.id} className="p-4"><div className="flex items-start justify-between gap-3"><h3 className="flex items-center gap-2 text-sm text-[#294735]"><span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: service.color }} />{service.name}</h3><strong className="shrink-0 text-xs text-[#254b38]">{money(service.received)}</strong></div><p className="mt-3 text-[10px] text-stone-500">{service.count} lessons · {service.participants} participants · {service.present} marked present</p></article>)}</div></> : <Empty title="Your story is still taking shape" icon={TrendingUp}>Service insights will appear once lessons have taken place. Try a longer reporting period.</Empty>}
      <p className="border-t border-[#edf0e8] px-4 py-4 text-[10px] leading-relaxed text-stone-400 sm:px-6">Linked receipts are payments attached directly to these lessons, regardless of receipt date. Package purchases and unallocated payments cannot be attributed to a service and are excluded from this table.</p>
    </section>
  </>;
}
