'use client';

import Link from 'next/link';
import {
  ArrowRight, CalendarDays, ChevronRight, CircleDot, ExternalLink, MapPin, MessageSquareText, Plus, RefreshCw, ShieldCheck, UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, loadFamilyChildProgress, loadFamilyChildSchedule } from '@/lib/api';
import { attendanceLabel, childScheduleState } from '@/lib/student-bookings';
import { childScheduleEvent, readHomeView, writeHomeView, type HomeView } from '@/lib/student-calendar';
import type { ChildSchedule, ChildScheduleItem, FamilyBookingChild } from '@/lib/types';
import { cn, shortDate, time } from '@/lib/utils';
import { BookingCalendar } from './booking-calendar';
import { ProgressView } from './progress-view';
import { EmptyState, ErrorNotice, LoadingScreen } from './shared';
import { chipClass, panel, primaryButton, secondaryButton, statusClass } from './styles';

export type ChildSegment = 'schedule' | 'progress';

function ChildSessionDialog({
  item,
  childName,
  nowMs,
  onClose,
  onReadFeedback,
}: {
  item: ChildScheduleItem | null;
  childName: string;
  nowMs: number;
  onClose: () => void;
  onReadFeedback: () => void;
}) {
  if (!item) return null;
  const zone = item.business.timezone;
  const state = childScheduleState(item, nowMs);
  const attendance = attendanceLabel(item.attendance);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">{item.serviceName}</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          {childName}’s place with {item.coachName} at {item.business.name}
        </DialogDescription>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-medium', statusClass(state))}>{state}</span>
          {attendance && <span className="rounded-full bg-[#e8eee3] px-2.5 py-1 text-[10px] font-medium text-[#4f6847]">{attendance}</span>}
          <span className="rounded-full bg-[#eceeea] px-2.5 py-1 text-[10px] font-medium text-[#4c5c4d]">{item.type === 'GROUP' ? 'Group Class' : 'Private Class'}</span>
        </div>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">When</dt>
            <dd className="mt-1 text-sm text-[#415244]">
              {shortDate(item.startAt, zone)}
              <span className="block text-xs text-[#59675c]">{time(item.startAt, zone)} – {time(item.endAt, zone)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Where</dt>
            <dd className="mt-1 text-sm text-[#415244]">
              {item.location.name}
              {(item.location.area || item.location.address) && (
                <span className="block text-xs text-[#59675c]">{[item.location.area, item.location.address].filter(Boolean).join(' · ')}</span>
              )}
              {item.location.mapsUrl && (
                <a href={item.location.mapsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-[#174c3c] underline underline-offset-2">
                  Open in maps <ExternalLink size={11} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Coach</dt>
            <dd className="mt-1 text-sm text-[#415244]">{item.coachName}</dd>
          </div>
          {item.sport && (
            <div>
              <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Sport</dt>
              <dd className="mt-1 text-sm text-[#415244]">{item.sport}</dd>
            </div>
          )}
        </dl>
        <p className="!mt-5 rounded-xl bg-[#f6f8f3] p-3 text-xs leading-relaxed text-[#59675c]">
          To change or cancel {childName}’s place, contact {item.business.name}. Guardian access here is read-only.
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5 border-t border-[#edf0e8] pt-5">
          {item.hasFeedback && (
            <button type="button" className={primaryButton} onClick={onReadFeedback}>
              <MessageSquareText size={15} aria-hidden="true" /> Read coach feedback
            </button>
          )}
          <Link href={`/book/${encodeURIComponent(item.business.slug)}`} className={secondaryButton}>
            Book at {item.business.name} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleRow({ item, nowMs, onOpen }: { item: ChildScheduleItem; nowMs: number; onOpen: () => void }) {
  const state = childScheduleState(item, nowMs);
  const zone = item.business.timezone;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open details for ${item.serviceName} at ${item.business.name}`}
        className={cn(panel, 'flex w-full items-center gap-3.5 p-4 text-left transition hover:bg-[#fafbf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]')}
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#eaf0e2] text-[#4f6847]"><CircleDot size={20} strokeWidth={1.6} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-semibold tracking-tight text-[#263e33]">{item.serviceName}</span>
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-medium', statusClass(state))}>{state}</span>
            {item.hasFeedback && <span className="rounded-full bg-[#e2ece8] px-2 py-0.5 text-[9px] font-medium text-[#3f6b5c]">Coach feedback</span>}
          </span>
          <span className="mt-1.5 block text-xs text-[#59675c]">
            {shortDate(item.startAt, zone)} · {time(item.startAt, zone)} · {item.business.name}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-[#59675c]">
            <MapPin size={11} aria-hidden="true" /> {item.location.name}{item.location.area ? ` · ${item.location.area}` : ''}
          </span>
        </span>
        <ChevronRight size={17} className="shrink-0 text-[#59675c]" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * A guardian's view of one linked child's training: schedule and coach
 * feedback, read through the Family projections. It is never a session as
 * the child — booking still happens from the adult's own account, where the
 * public booking page asks who the place is for — and it carries no
 * payments, packages, rentals or chat.
 */
export function ChildPlayerView({
  child,
  userId,
  nowMs,
  todayKey,
  segment,
  onSegment,
  onBook,
  onExit,
}: {
  child: FamilyBookingChild;
  userId: string;
  nowMs: number;
  todayKey: string;
  segment: ChildSegment;
  onSegment: (segment: ChildSegment) => void;
  onBook: () => void;
  onExit: () => void;
}) {
  const [schedule, setSchedule] = useState<ChildSchedule | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<HomeView>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  const name = child.displayName;

  useEffect(() => { setView(readHomeView(userId)); }, [userId]);

  useEffect(() => {
    let ignore = false;
    setSchedule(null);
    setError(null);
    loadFamilyChildSchedule(child.id)
      .then(value => { if (!ignore) setSchedule(value); })
      .catch(caught => {
        if (ignore) return;
        const status = caught instanceof ApiError ? caught.status : 0;
        setError({
          status,
          message: status === 404
            ? `${name}’s schedule is not available. Check that your guardian link and consent are current in Family.`
            : status === 503
              ? 'Family features are temporarily unavailable. Please try again later.'
              : caught instanceof Error ? caught.message : 'The schedule could not be loaded.',
        });
      });
    return () => { ignore = true; };
  }, [attempt, child.id, name]);

  const loadProgress = useCallback(() => loadFamilyChildProgress(child.id), [child.id]);
  const items = useMemo(() => schedule?.bookings ?? [], [schedule]);
  const upcoming = useMemo(() => items
    .filter(item => { const state = childScheduleState(item, nowMs); return state !== 'Cancelled' && state !== 'Completed'; })
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()), [items, nowMs]);
  const recent = useMemo(() => items
    .filter(item => !upcoming.includes(item))
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime()), [items, upcoming]);
  const events = useMemo(() => items.map(item => childScheduleEvent(item, nowMs)), [items, nowMs]);
  const openItem = openId ? items.find(item => item.participantId === openId) ?? null : null;

  function chooseView(next: HomeView) {
    setView(next);
    writeHomeView(userId, next);
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: ChildSegment = event.key === 'Home' ? 'schedule' : event.key === 'End' ? 'progress' : segment === 'schedule' ? 'progress' : 'schedule';
    onSegment(next);
    document.getElementById(`child-${next}-tab`)?.focus();
  }

  const bookAction = (
    <button type="button" className={primaryButton} onClick={onBook}>
      <Plus size={15} aria-hidden="true" /> Book a Class for {name}
    </button>
  );

  return (
    <section id="student-child-panel" aria-labelledby="child-view-title" className="student-tab-panel">
      <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">Viewing as {name}</p>
      <h1 id="child-view-title" className="!mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">{name}’s training</h1>
      <p className="!mt-1 text-sm text-[#59675c]">@{child.username}</p>

      <div className="mt-5 flex gap-2.5 rounded-xl border border-[#dfe7d8] bg-[#f0f5ea] p-4 text-xs leading-relaxed text-[#3d5a41]">
        <ShieldCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <p>
          You’re viewing {name}’s schedule and coach feedback as their guardian. Courtly never signs you in as {name};
          to book, choose a club and pick {name} on its booking page.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2.5">
        {bookAction}
        <Link href="/family" className={secondaryButton}>
          <UserRound size={15} aria-hidden="true" /> Profile &amp; consent in Family
        </Link>
        <button type="button" className={secondaryButton} onClick={onExit}>Back to my bookings</button>
      </div>

      <div role="tablist" aria-label={`${name}’s training`} className="mt-7 grid grid-cols-2 gap-2 rounded-2xl bg-[#eaf0e5] p-1.5">
        {(['schedule', 'progress'] as const).map(value => (
          <button
            key={value}
            id={`child-${value}-tab`}
            type="button"
            role="tab"
            aria-selected={segment === value}
            aria-controls={`child-${value}-panel`}
            tabIndex={segment === value ? 0 : -1}
            onClick={() => onSegment(value)}
            onKeyDown={tabKey}
            className={cn(
              'min-h-11 rounded-xl px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
              segment === value ? 'bg-white text-[#174c3c] shadow-sm' : 'text-[#59675c] hover:bg-white/60',
            )}
          >
            {value === 'schedule' ? 'Schedule' : 'Progress'}
          </button>
        ))}
      </div>

      {segment === 'schedule' ? (
        <div id="child-schedule-panel" role="tabpanel" aria-labelledby="child-schedule-tab" className="mt-6">
          {error ? (
            <div className="space-y-3">
              <ErrorNotice message={error.message} />
              <div className="flex flex-wrap gap-2">
                {error.status !== 404 && (
                  <button type="button" className={secondaryButton} onClick={() => setAttempt(value => value + 1)}>
                    <RefreshCw size={14} aria-hidden="true" /> Try again
                  </button>
                )}
                <Link href="/family" className={secondaryButton}>Open Family</Link>
              </div>
            </div>
          ) : !schedule ? (
            <LoadingScreen compact text={`Loading ${name}’s schedule…`} />
          ) : items.length === 0 ? (
            <EmptyState icon={<CalendarDays size={23} />} title={`Nothing booked for ${name} yet`} action={bookAction}>
              Classes you book for {name} appear here, along with sessions from the last 90 days.
            </EmptyState>
          ) : (
            <>
              <div role="group" aria-label="Show schedule as" className="mb-5 inline-flex gap-1 rounded-xl bg-[#eaf0e5] p-1">
                {(['list', 'calendar'] as const).map(value => (
                  <button key={value} type="button" aria-pressed={view === value} onClick={() => chooseView(value)} className={cn(chipClass(view === value), '!rounded-lg')}>
                    {value === 'list' ? 'List' : 'Calendar'}
                  </button>
                ))}
              </div>
              {view === 'calendar' ? (
                <BookingCalendar
                  idPrefix="child-calendar"
                  label={`${name}’s calendar`}
                  events={events}
                  todayKey={todayKey}
                  onOpen={(event) => setOpenId(event.id)}
                />
              ) : (
                <div className="space-y-8">
                  <section aria-labelledby="child-upcoming">
                    <h2 id="child-upcoming" className="text-xl font-semibold tracking-tight">Upcoming</h2>
                    {upcoming.length ? (
                      <ul className="mt-3 space-y-3">{upcoming.map(item => <ScheduleRow key={item.participantId} item={item} nowMs={nowMs} onOpen={() => setOpenId(item.participantId)} />)}</ul>
                    ) : (
                      <p className="!mt-3 rounded-2xl border border-dashed border-[#dfe5dc] bg-white px-5 py-6 text-center text-sm text-[#59675c]">Nothing upcoming for {name}.</p>
                    )}
                  </section>
                  {recent.length > 0 && (
                    <section aria-labelledby="child-recent">
                      <h2 id="child-recent" className="text-xl font-semibold tracking-tight">Recent</h2>
                      <ul className="mt-3 space-y-3">{recent.map(item => <ScheduleRow key={item.participantId} item={item} nowMs={nowMs} onOpen={() => setOpenId(item.participantId)} />)}</ul>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div id="child-progress-panel" role="tabpanel" aria-labelledby="child-progress-tab" className="mt-6">
          <ProgressView
            idPrefix="child-progress"
            headingLevel={2}
            eyebrowText={`${name}’s progress`}
            title="Progress and coach feedback"
            description={`Attendance statistics and the notes ${name}’s coaches have shared.`}
            load={loadProgress}
            serverFilters={false}
            subjectName={name}
            emptyAction={bookAction}
          />
        </div>
      )}

      <ChildSessionDialog
        item={openItem}
        childName={name}
        nowMs={nowMs}
        onClose={() => setOpenId(null)}
        onReadFeedback={() => { setOpenId(null); onSegment('progress'); }}
      />
    </section>
  );
}
