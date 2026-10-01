'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChartNoAxesColumn, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, loadFamilyChildProgress, loadFamilyChildSchedule } from '@/lib/api';
import type { ChildProgress, ChildSchedule, FamilyChild } from '@/lib/types';
import { ChildProgressPanel } from './child-progress';
import { ChildSchedulePanel } from './child-schedule';
import type { FamilyBookingTarget } from './family-helpers';

type PanelKind = 'schedule' | 'progress';
type Loadable<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: T; loadedAt: number }
  | { state: 'error'; message: string };
type Unavailable = 'NOT_FOUND' | 'DISABLED';

/**
 * The guardian's read-only window onto one child's Classes and progress. The
 * server re-derives authority on every request and answers 404 (or 503 while
 * Family is switched off), so either answer retires the entry points quietly
 * instead of leaving a broken panel behind.
 */
export function ChildTrainingSection({ child, bookingTargets, onUnauthorized }: {
  child: Pick<FamilyChild, 'id' | 'displayName'>;
  bookingTargets: FamilyBookingTarget[];
  onUnauthorized: () => void;
}) {
  const id = useId();
  const name = child.displayName;
  const [open, setOpen] = useState<PanelKind | null>(null);
  const [schedule, setSchedule] = useState<Loadable<ChildSchedule>>({ state: 'idle' });
  const [progress, setProgress] = useState<Loadable<ChildProgress>>({ state: 'idle' });
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [focusPanel, setFocusPanel] = useState(false);
  const [focusNotice, setFocusNotice] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const unavailableRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  const requests = useRef({ schedule: 0, progress: 0 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!focusPanel || !open) return;
    setFocusPanel(false);
    headingRef.current?.focus();
  }, [focusPanel, open]);
  useEffect(() => {
    if (!focusNotice || !unavailable) return;
    setFocusNotice(false);
    unavailableRef.current?.focus();
  }, [focusNotice, unavailable]);

  const fail = useCallback((cause: unknown, set: (value: Loadable<never>) => void) => {
    if (cause instanceof ApiError && cause.status === 401) { onUnauthorized(); return; }
    if (cause instanceof ApiError && (cause.status === 404 || cause.status === 503)) {
      // The control the person used is about to disappear; move focus to the explanation that replaces it.
      setFocusNotice(!!rootRef.current?.contains(document.activeElement));
      setOpen(null);
      setUnavailable(cause.status === 404 ? 'NOT_FOUND' : 'DISABLED');
      return;
    }
    set({ state: 'error', message: cause instanceof Error && cause.message ? cause.message : 'This could not be loaded. Try again.' });
  }, [onUnauthorized]);

  const load = useCallback(async (panel: PanelKind) => {
    const request = ++requests.current[panel];
    const current = () => mounted.current && requests.current[panel] === request;
    if (panel === 'schedule') {
      setSchedule({ state: 'loading' });
      try {
        const data = await loadFamilyChildSchedule(child.id);
        if (current()) setSchedule({ state: 'ready', data, loadedAt: Date.now() });
      } catch (cause) { if (current()) fail(cause, setSchedule); }
    } else {
      setProgress({ state: 'loading' });
      try {
        const data = await loadFamilyChildProgress(child.id);
        if (current()) setProgress({ state: 'ready', data, loadedAt: Date.now() });
      } catch (cause) { if (current()) fail(cause, setProgress); }
    }
  }, [child.id, fail]);

  function show(panel: PanelKind, moveFocus = false) {
    setOpen(panel);
    if (moveFocus) setFocusPanel(true);
    const state = panel === 'schedule' ? schedule.state : progress.state;
    if (state === 'idle' || state === 'error') void load(panel);
  }
  function toggle(panel: PanelKind) {
    if (open === panel) setOpen(null);
    else show(panel);
  }

  const bookLinks = bookingTargets.map(target => <Button key={target.href} asChild variant="outline" className="!h-auto min-h-11 whitespace-normal py-2 text-left">
    <Link href={target.href}><Plus size={15} aria-hidden="true" className="shrink-0" />{target.clubName ? `Book a Class for ${name} at ${target.clubName}` : `Book a Class for ${name}`}</Link>
  </Button>);

  if (unavailable) {
    return <div ref={rootRef} className="mt-5 border-t border-[#edf0e8] pt-5">
      <p ref={unavailableRef} tabIndex={-1} role="status" className="rounded-xl border border-[#e7ddc8] bg-[#fffaf0] p-4 text-sm leading-relaxed text-[#756345] outline-none">
        {unavailable === 'DISABLED'
          ? `${name}’s schedule and progress are temporarily unavailable. Try again later.`
          : `${name}’s schedule and progress aren’t available from your Family link right now. They need an active link with booking permission and current consent.`}
      </p>
    </div>;
  }

  const panelId = `${id}-panel`;
  const headingId = `${id}-heading`;
  const active = open === 'schedule' ? schedule : open === 'progress' ? progress : null;
  return <div ref={rootRef} className="mt-5 border-t border-[#edf0e8] pt-5">
    <h3 className="text-sm font-semibold text-[#304b39]">Classes and progress</h3>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" variant={open === 'schedule' ? 'default' : 'outline'} aria-expanded={open === 'schedule'} aria-controls={open === 'schedule' ? panelId : undefined} onClick={() => toggle('schedule')}>
        <CalendarDays size={15} aria-hidden="true" />Schedule<span className="sr-only"> for {name}</span>
      </Button>
      <Button type="button" variant={open === 'progress' ? 'default' : 'outline'} aria-expanded={open === 'progress'} aria-controls={open === 'progress' ? panelId : undefined} onClick={() => toggle('progress')}>
        <ChartNoAxesColumn size={15} aria-hidden="true" />Progress<span className="sr-only"> for {name}</span>
      </Button>
      {bookLinks}
    </div>
    {!bookingTargets.length && <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">To book, open a club’s booking page and choose {name} under “Who is playing?”.</p>}
    {open && active && <section id={panelId} aria-labelledby={headingId} className="mt-4 rounded-2xl border border-[#e2e7dd] bg-[#f8faf6] p-4 sm:p-5">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-[#1c3029] outline-none">{open === 'schedule' ? `${name}’s schedule` : `${name}’s progress`}</h3>
      <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">
        <strong className="font-semibold text-[#405941]">View only.</strong>{' '}
        {open === 'schedule'
          ? `Family can’t change ${name}’s Classes: to cancel or reschedule, contact the club. To book another Class, open the club’s booking page and choose ${name} under “Who is playing?”.`
          : `This shows what coaches have chosen to share with ${name}’s family. Internal club notes are never shown here.`}
      </p>
      {active.state === 'loading' || active.state === 'idle'
        ? <p role="status" className="!mt-4 flex items-center gap-2 text-sm text-[#59675c]"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{open === 'schedule' ? `Loading ${name}’s schedule…` : `Loading ${name}’s progress…`}</p>
        : active.state === 'error'
          ? <div className="mt-4 rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-4"><p role="alert" className="text-sm text-[#8a4937]">{active.message}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => { setFocusPanel(true); void load(open); }}><RefreshCw size={14} aria-hidden="true" />Try again</Button></div>
          : open === 'schedule' && schedule.state === 'ready'
            ? <ChildSchedulePanel schedule={schedule.data} childName={name} now={schedule.loadedAt} onShowProgress={() => show('progress', true)} />
            : open === 'progress' && progress.state === 'ready'
              ? <ChildProgressPanel progress={progress.data} childName={name} />
              : null}
    </section>}
  </div>;
}
