'use client';

import { useId, useState } from 'react';
import { Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ChildProgress } from '@/lib/types';
import {
  feedbackAuthor, feedbackSections, formatAttendanceRate, formatHours, formatWeeks, goalByline, monthlyBars,
  monthlySummary, plural, progressDate, streakDetail,
} from '@/lib/progress-format';

const FEEDBACK_PAGE = 5;

/** Presentational: read-only stats, monthly attendance, goal, and shared coach feedback for one child. */
export function ChildProgressPanel({ progress, childName }: { progress: ChildProgress; childName: string }) {
  const id = useId();
  const [allFeedback, setAllFeedback] = useState(false);
  const { stats, currentGoal, feedback } = progress;
  const bars = monthlyBars(progress.monthly);
  const visibleFeedback = allFeedback ? feedback : feedback.slice(0, FEEDBACK_PAGE);
  const tiles = [
    { label: 'Classes attended', value: String(stats.attended), detail: stats.upcoming ? `${stats.upcoming} upcoming` : 'None booked ahead' },
    { label: 'Attendance rate', value: formatAttendanceRate(stats.attendanceRate), detail: stats.attendanceRate == null ? 'Shown once attendance is marked' : 'Of Classes marked present or absent' },
    { label: 'Weekly streak', value: formatWeeks(stats.currentStreakWeeks), detail: streakDetail(stats.currentStreakWeeks, stats.longestStreakWeeks) },
    { label: 'Hours on court', value: formatHours(stats.hoursOnCourt), detail: stats.lastAttendedAt ? `Last Class ${progressDate(stats.lastAttendedAt)}` : 'No Classes attended yet' },
  ];
  return <div className="mt-4 flex flex-col gap-6">
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map(tile => <div key={tile.label} className="min-w-0 rounded-xl border border-[#e6eadf] bg-white p-3.5">
        <dt className="text-xs text-[#59675c]">{tile.label}</dt>
        <dd className="mt-1 break-words text-xl font-semibold tracking-tight text-[#1c3029]">{tile.value}</dd>
        <dd className="mt-1 text-xs leading-snug text-[#59675c]">{tile.detail}</dd>
      </div>)}
    </dl>

    <figure className="rounded-xl border border-[#e6eadf] bg-white p-4">
      <figcaption>
        <h4 className="text-sm font-semibold text-[#304b39]">Classes attended each month</h4>
        <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">{monthlySummary(progress.monthly)}</p>
      </figcaption>
      {bars.length > 0 && <ol className="!mt-4 grid items-end gap-2" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
        {bars.map(bar => <li key={bar.month} className="flex min-w-0 flex-col items-center gap-1.5">
          <span aria-hidden="true" className="text-xs font-semibold text-[#304b39]">{bar.attended}</span>
          <span aria-hidden="true" className="flex h-24 w-full items-end justify-center">
            <span className={`block w-full max-w-9 rounded-t-md ${bar.attended > 0 ? 'bg-[#507448]' : 'bg-[#dfe6d6]'}`} style={{ height: bar.attended > 0 ? `${Math.max(bar.percent, 6)}%` : '3px' }} />
          </span>
          <span aria-hidden="true" className="text-xs text-[#59675c]">{bar.short}</span>
          <span className="sr-only">{bar.long}: {plural(bar.attended, 'Class', 'Classes')} attended</span>
        </li>)}
      </ol>}
    </figure>

    <section aria-labelledby={`${id}-goal`} className="rounded-xl border border-[#dfe7d8] bg-[#f3f7ef] p-4">
      <h4 id={`${id}-goal`} className="flex items-center gap-2 text-sm font-semibold text-[#304b39]"><Target size={15} aria-hidden="true" />Current goal</h4>
      {currentGoal
        ? <><p className="!mt-2 whitespace-pre-line break-words text-base text-[#1c3029]">{currentGoal.text}</p><p className="!mt-2 text-xs text-[#59675c]">{goalByline(currentGoal)}</p></>
        : <p className="!mt-2 text-sm text-[#59675c]">No goal yet. A coach can set {childName}’s next goal when they share feedback.</p>}
    </section>

    <section aria-labelledby={`${id}-feedback`}>
      <h4 id={`${id}-feedback`} className="text-sm font-semibold text-[#304b39]">Shared coach feedback <span className="font-normal text-[#59675c]">({feedback.length})</span></h4>
      {feedback.length
        ? <ol className="!mt-3 grid gap-3">
          {visibleFeedback.map(entry => {
            const sections = feedbackSections(entry);
            return <li key={entry.id} className="rounded-xl border border-[#e6eadf] bg-white p-4">
              <p className="break-words text-sm font-semibold text-[#304b39]">{entry.serviceName}</p>
              <p className="!mt-0.5 text-xs text-[#59675c]">{progressDate(entry.sessionStartAt, entry.timezone)} · {entry.business.name} · {feedbackAuthor(entry)}</p>
              {sections.length > 0 && <dl className="mt-3 grid gap-2.5">
                {sections.map(section => <div key={section.label}>
                  <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-[#59675c]">{section.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-[#1c3029]">{section.text}</dd>
                </div>)}
              </dl>}
              {entry.editedAt && <p className="!mt-3 text-xs text-[#59675c]">Updated {progressDate(entry.editedAt, entry.timezone)}</p>}
            </li>;
          })}
        </ol>
        : <p className="!mt-2 text-sm text-[#59675c]">No shared feedback yet. Coaches can share notes with {childName}’s family after a Class.</p>}
      {feedback.length > FEEDBACK_PAGE && <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={allFeedback} onClick={() => setAllFeedback(value => !value)}>{allFeedback ? 'Show less feedback' : `Show all ${feedback.length} feedback notes`}</Button>}
    </section>
  </div>;
}
