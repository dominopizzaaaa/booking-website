'use client';

import { useId, useState } from 'react';
import { MessageSquareText, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ChildSchedule, ChildScheduleItem, Status } from '@/lib/types';
import { attendanceLabel, classWhenLabel, clubTimeZoneNote, safeExternalUrl, scheduleStatusLabel, splitChildSchedule } from './family-helpers';

const RECENT_PAGE = 6;
const statusTone: Record<Status, string> = {
  CONFIRMED: 'bg-[#edf5e4] text-[#4f6847]',
  PENDING: 'bg-[#fff2d8] text-[#785c24]',
  CANCELLED: 'bg-[#fbebeb] text-[#8b4d3c]',
  COMPLETED: 'bg-[#e8eef4] text-[#4f687d]',
};

function ScheduleItem({ item, now }: { item: ChildScheduleItem; now: number }) {
  const when = classWhenLabel(item);
  const started = new Date(item.startAt).getTime() <= now;
  const attendance = attendanceLabel(item.attendance, started, item.status);
  const mapsUrl = safeExternalUrl(item.location.mapsUrl);
  const area = item.location.area?.trim();
  const address = item.location.address?.trim();
  return <li className="rounded-xl border border-[#e6eadf] bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#304b39]">{when.date}</p>
        <p className="!mt-0.5 text-sm text-[#59675c]">{when.time}</p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone[item.status] ?? statusTone.CONFIRMED}`}>{scheduleStatusLabel(item.status)}</span>
    </div>
    <p className="!mt-3 break-words text-base font-semibold text-[#1c3029]">{item.serviceName}</p>
    <p className="!mt-0.5 text-xs text-[#59675c]">{item.type === 'GROUP' ? 'Group Class' : 'Private Class'}{item.sport ? ` · ${item.sport}` : ''}</p>
    <dl className="!mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div className="flex min-w-0 gap-2"><dt className="w-14 shrink-0 text-xs leading-5 text-[#59675c]">Club</dt><dd className="min-w-0 break-words text-[#304b39]">{item.business.name}</dd></div>
      <div className="flex min-w-0 gap-2"><dt className="w-14 shrink-0 text-xs leading-5 text-[#59675c]">Coach</dt><dd className="min-w-0 break-words text-[#304b39]">{item.coachName}</dd></div>
      <div className="flex min-w-0 gap-2 sm:col-span-2"><dt className="w-14 shrink-0 text-xs leading-5 text-[#59675c]">Venue</dt><dd className="min-w-0 break-words text-[#304b39]">
        <span>{item.location.name}{area ? <span className="text-[#59675c]"> · {area}</span> : null}</span>
        {address && <span className="mt-0.5 block text-xs text-[#59675c]">{address}</span>}
        {mapsUrl && <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-[#45673c] underline underline-offset-2 sm:min-h-0"><Navigation size={14} aria-hidden="true" />Directions<span className="sr-only"> to {item.location.name} (opens in a new tab)</span></a>}
      </dd></div>
    </dl>
    {(attendance || item.hasFeedback) && <div className="mt-3 flex flex-wrap gap-2 border-t border-[#edf0e8] pt-3 text-xs">
      {attendance && <span className="rounded-full bg-[#f1f4ee] px-2.5 py-1 font-semibold text-[#4d5e51]">{attendance}</span>}
      {item.hasFeedback && <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e8f0f6] px-2.5 py-1 font-semibold text-[#3f5f78]"><MessageSquareText size={13} aria-hidden="true" />Coach feedback available</span>}
    </div>}
  </li>;
}

/** Presentational: the guardian's read-only list of one child's Classes. */
export function ChildSchedulePanel({ schedule, childName, now, onShowProgress }: {
  schedule: ChildSchedule; childName: string; now: number; onShowProgress?: () => void;
}) {
  const id = useId();
  const [allRecent, setAllRecent] = useState(false);
  const { upcoming, recent } = splitChildSchedule(schedule.bookings, now);
  const zoneNote = clubTimeZoneNote(schedule.bookings);
  const feedbackCount = schedule.bookings.filter(item => item.hasFeedback).length;
  if (!schedule.bookings.length) {
    return <p className="!mt-4 rounded-xl bg-white p-4 text-sm leading-relaxed text-[#59675c]">No Classes for {childName} in the last 90 days, and none booked ahead yet.</p>;
  }
  return <div className="mt-4 flex flex-col gap-6">
    {zoneNote && <p className="text-xs text-[#59675c]">{zoneNote}</p>}
    <section aria-labelledby={`${id}-upcoming`}>
      <h4 id={`${id}-upcoming`} className="text-sm font-semibold text-[#304b39]">Upcoming <span className="font-normal text-[#59675c]">({upcoming.length})</span></h4>
      {upcoming.length
        ? <ol className="!mt-3 grid gap-3">{upcoming.map(item => <ScheduleItem key={item.participantId} item={item} now={now} />)}</ol>
        : <p className="!mt-2 text-sm text-[#59675c]">Nothing booked ahead for {childName}.</p>}
    </section>
    <section aria-labelledby={`${id}-recent`}>
      <h4 id={`${id}-recent`} className="text-sm font-semibold text-[#304b39]">Recent <span className="font-normal text-[#59675c]">· last 90 days ({recent.length})</span></h4>
      {recent.length
        ? <ol className="!mt-3 grid gap-3">{(allRecent ? recent : recent.slice(0, RECENT_PAGE)).map(item => <ScheduleItem key={item.participantId} item={item} now={now} />)}</ol>
        : <p className="!mt-2 text-sm text-[#59675c]">No Classes in the last 90 days.</p>}
      {recent.length > RECENT_PAGE && <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={allRecent} onClick={() => setAllRecent(value => !value)}>{allRecent ? 'Show fewer recent Classes' : `Show all ${recent.length} recent Classes`}</Button>}
    </section>
    {feedbackCount > 0 && onShowProgress && <p className="text-sm text-[#59675c]">{feedbackCount === 1 ? 'One Class has' : `${feedbackCount} Classes have`} shared coach feedback. <button type="button" className="inline min-h-0 font-semibold text-[#45673c] underline underline-offset-2" onClick={onShowProgress}>Read it in Progress</button></p>}
  </div>;
}
