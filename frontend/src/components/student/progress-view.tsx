'use client';

import { BarChart3, ChevronDown, MessageSquareText, RefreshCw, Target } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  attendanceRateText, authorRoleLabel, cleanProgressFilters, feedbackFields, feedbackPreview, filterFeedback,
  hoursText, monthlyChart, progressFiltersActive, streakText, weeksText,
} from '@/lib/progress';
import type { LearnerFeedback, ProgressFilters, ProgressSummary } from '@/lib/types';
import { cn, shortDate, time } from '@/lib/utils';
import { Disclosure, SeeMoreButton } from '@/components/ui/progressive-disclosure';
import { EmptyState, ErrorNotice, LoadingScreen } from './shared';
import { compactButton, eyebrow, field, panel, secondaryButton } from './styles';

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function MonthlyChart({ monthly, idPrefix }: { monthly: ProgressSummary['monthly']; idPrefix: string }) {
  const chart = monthlyChart(monthly);
  if (chart.bars.length === 0) return null;
  return (
    <figure aria-labelledby={`${idPrefix}-chart-caption`} className="mt-5">
      <figcaption id={`${idPrefix}-chart-caption`} className="text-xs font-semibold text-[#465e4c]">
        Sessions attended, last {chart.bars.length} months
      </figcaption>
      {/* The bars are decoration for sighted readers; the table carries the numbers. */}
      <div aria-hidden="true" className="mt-3 flex h-32 items-end gap-2 rounded-xl bg-[#f6f8f3] px-3 pb-2 pt-3">
        {chart.bars.map(bar => (
          <div key={bar.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] font-semibold text-[#34533e]">{bar.attended}</span>
            <span
              className={cn('w-full max-w-10 rounded-t-md', bar.attended > 0 ? 'bg-[#2f7a57]' : 'bg-[#d9e2d5]')}
              style={{ height: bar.attended > 0 ? `${Math.max(6, bar.percent)}%` : '3px' }}
            />
            <span className="text-[10px] text-[#59675c]">{bar.label}</span>
          </div>
        ))}
      </div>
      {/* Tables ignore sr-only's 1px width, so a hidden table widened phone
          layouts. Hiding a wrapping block keeps the table out of the layout. */}
      <div className="sr-only">
        <table>
          <caption>{chart.summary}</caption>
          <thead><tr><th scope="col">Month</th><th scope="col">Sessions attended</th></tr></thead>
          <tbody>
            {chart.bars.map(bar => <tr key={bar.month}><th scope="row">{bar.longLabel}</th><td>{bar.attended}</td></tr>)}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function FeedbackItem({
  item,
  expanded,
  viewed,
  onToggle,
  headingLevel,
}: {
  item: LearnerFeedback;
  expanded: boolean;
  viewed: boolean;
  onToggle: () => void;
  headingLevel: 3 | 4;
}) {
  const Title = headingLevel === 3 ? 'h3' : 'h4';
  const fields = feedbackFields(item);
  const panelId = `feedback-${item.id}-detail`;
  return (
    <li>
      <article aria-labelledby={`feedback-${item.id}-title`} className="rounded-xl border border-[#e4e9df] bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Title id={`feedback-${item.id}-title`} className="text-sm font-semibold text-[#304b39]">{item.serviceName}</Title>
            <p className="!mt-1 text-xs text-[#59675c]">
              {shortDate(item.sessionStartAt, item.timezone)} at {time(item.sessionStartAt, item.timezone)} · {item.business.name}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!viewed && <span className="rounded-full bg-[#f6ebd5] px-2 py-0.5 text-[10px] font-semibold text-[#70582e]">New</span>}
            <span className="rounded-full bg-[#e2ece8] px-2 py-0.5 text-[10px] font-semibold text-[#3f6b5c]">{authorRoleLabel(item.authorRole)}</span>
          </div>
        </div>
        <p className="!mt-2 text-[11px] text-[#59675c]">
          From {item.coachName}{item.sport ? ` · ${item.sport}` : ''}{item.editedAt ? ' · edited' : ''}
        </p>
        {!expanded && <p className="!mt-2 text-sm leading-relaxed text-[#415244]">{feedbackPreview(item)}</p>}
        <dl id={panelId} hidden={!expanded} className="mt-3 space-y-3">
            {fields.map(entry => (
              <div key={entry.key}>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-[#59675c]">{entry.label}</dt>
                <dd className="mt-1 whitespace-pre-line text-sm leading-relaxed text-[#304b39]">{entry.text}</dd>
              </div>
            ))}
        </dl>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(compactButton, 'mt-3')}
        >
          <ChevronDown size={14} aria-hidden="true" className={cn('transition', expanded && 'rotate-180')} />
          {expanded ? 'Show less' : 'Read full feedback'}
          <span className="sr-only"> for {item.serviceName} on {shortDate(item.sessionStartAt, item.timezone)}</span>
        </button>
      </article>
    </li>
  );
}

/**
 * Progress, in two clearly separate parts: numbers Courtly calculates from
 * recorded attendance, and notes a coach chose to share. Learners filter on
 * the server; a guardian's child projection does not accept filters, so the
 * same controls narrow the feedback timeline in the browser instead.
 */
export function ProgressView({
  idPrefix,
  title,
  eyebrowText,
  description,
  headingLevel = 1,
  load,
  serverFilters,
  markViewed,
  subjectName,
  emptyAction,
  backAction,
}: {
  idPrefix: string;
  title: string;
  eyebrowText: string;
  description: string;
  headingLevel?: 1 | 2;
  load: (filters: ProgressFilters) => Promise<ProgressSummary>;
  serverFilters: boolean;
  markViewed?: (id: string) => Promise<unknown>;
  subjectName?: string;
  emptyAction?: ReactNode;
  backAction?: ReactNode;
}) {
  const [filters, setFilters] = useState<ProgressFilters>({});
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [filterOptions, setFilterOptions] = useState<ProgressSummary['filters'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [showMoreStats, setShowMoreStats] = useState(false);
  const [showAllFeedback, setShowAllFeedback] = useState(false);
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);
  const requestFilters = serverFilters ? cleanProgressFilters(filters) : {};
  const filterKey = JSON.stringify(requestFilters);

  const fetchSummary = useCallback(async (values: ProgressFilters) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const value = await load(values);
      if (requestRef.current !== request) return;
      setSummary(value);
      // Keep the unfiltered choices so narrowing never removes the way back.
      setFilterOptions(current => current && progressFiltersActive(values) ? current : value.filters);
    } catch (caught) {
      if (requestRef.current === request) setError(messageOf(caught));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void fetchSummary(JSON.parse(filterKey) as ProgressFilters);
  }, [fetchSummary, filterKey, reload]);

  const timeline = useMemo(() => {
    if (!summary) return [];
    return serverFilters ? summary.feedback : filterFeedback(summary.feedback, filters);
  }, [filters, serverFilters, summary]);

  function toggle(item: LearnerFeedback) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    if (markViewed && !item.viewed && !viewed.has(item.id)) {
      setViewed(current => new Set(current).add(item.id));
      // Viewing is a receipt for the coach, never a gate for the learner;
      // a failed receipt is simply retried the next time it is opened.
      void markViewed(item.id).catch(() => setViewed(current => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      }));
    }
  }

  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const Sub = headingLevel === 1 ? 'h2' : 'h3';
  const options = filterOptions ?? summary?.filters ?? null;
  const active = progressFiltersActive(filters);
  const possessive = subjectName ? `${subjectName}’s` : 'your';
  const stats = summary?.stats;
  const primaryStats = stats ? [
    ['Sessions attended', String(stats.attended)],
    ['Current streak', streakText(stats.currentStreakWeeks)],
    ['Time on court', hoursText(stats.hoursOnCourt)],
    ['Upcoming sessions', String(stats.upcoming)],
  ] : [];
  const secondaryStats = stats ? [
    ['Longest streak', weeksText(stats.longestStreakWeeks)],
    ['Attendance rate', attendanceRateText(stats.attendanceRate)],
    ['Clubs', String(stats.clubs)],
    ['Coaches', String(stats.coaches)],
  ] : [];

  return (
    <div className="space-y-6">
      <div>
        {backAction}
        <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">{eyebrowText}</p>
        <Heading
          id={`${idPrefix}-title`}
          className={headingLevel === 1
            ? '!mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]'
            : '!mt-1 text-xl font-semibold tracking-tight text-[#20382d]'}
        >
          {title}
        </Heading>
        <p className="!mt-2 max-w-xl text-sm leading-relaxed text-[#59675c]">{description}</p>
      </div>

      {error && !summary ? (
        <div className="space-y-3">
          <ErrorNotice message={error} />
          <button type="button" className={secondaryButton} onClick={() => setReload(value => value + 1)}>
            <RefreshCw size={14} aria-hidden="true" /> Try progress again
          </button>
        </div>
      ) : !summary ? (
        <LoadingScreen compact text="Loading progress…" />
      ) : (
        <>
          {summary.currentGoal && (
            <section aria-labelledby={`${idPrefix}-goal`} className="rounded-2xl border border-[#d6e4dd] bg-[#f0f6f2] p-5">
              <div className="flex items-start gap-3">
                <Target size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-[#3f6b5c]" />
                <div className="min-w-0">
                  <p className={eyebrow}>From {possessive} coach</p>
                  <Sub id={`${idPrefix}-goal`} className="!mt-1 text-base font-semibold text-[#263e33]">Current goal</Sub>
                  <p className="!mt-2 text-sm leading-relaxed text-[#304b39]">{summary.currentGoal.text}</p>
                  <p className="!mt-2 text-[11px] text-[#59675c]">
                    {summary.currentGoal.coachName} · {summary.currentGoal.businessName} · {shortDate(summary.currentGoal.setAt)}
                  </p>
                </div>
              </div>
            </section>
          )}

          <section aria-labelledby={`${idPrefix}-stats`} className={cn(panel, 'p-5')}>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8edf2] text-[#4f687d]"><BarChart3 size={18} aria-hidden="true" /></span>
              <div>
                <p className={eyebrow}>Automatic statistics</p>
                <Sub id={`${idPrefix}-stats`} className="!mt-1 text-lg font-semibold tracking-tight">Training at a glance</Sub>
                <p className="!mt-1 text-xs text-[#59675c]">Based on recorded attendance; late counts as attended.</p>
              </div>
            </div>
            {stats && (
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {primaryStats.map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-[#f6f8f3] p-3">
                    <dt className="text-[10px] uppercase tracking-wide text-[#59675c]">{label}</dt>
                    <dd className="mt-1 text-sm font-semibold text-[#34533e]">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {serverFilters && active && <p className="!mt-3 text-[11px] text-[#59675c]">Statistics reflect the filters below.</p>}
            <div id={`${idPrefix}-more-stats`} hidden={!showMoreStats}>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {secondaryStats.map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-[#f6f8f3] p-3">
                    <dt className="text-[10px] uppercase tracking-wide text-[#59675c]">{label}</dt>
                    <dd className="mt-1 text-sm font-semibold text-[#34533e]">{value}</dd>
                  </div>
                ))}
              </dl>
              <MonthlyChart monthly={summary.monthly} idPrefix={idPrefix} />
            </div>
            <SeeMoreButton
              expanded={showMoreStats}
              controls={`${idPrefix}-more-stats`}
              hiddenCount={secondaryStats.length}
              noun="statistics"
              collapsedLabel="More progress"
              onToggle={() => setShowMoreStats((value) => !value)}
              className="mt-3 w-full"
            />
          </section>

          <section aria-labelledby={`${idPrefix}-feedback`} className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e2ece8] text-[#3f6b5c]"><MessageSquareText size={18} aria-hidden="true" /></span>
              <div>
                <p className={eyebrow}>Written by coaches</p>
                <Sub id={`${idPrefix}-feedback`} className="!mt-1 text-lg font-semibold tracking-tight">Coach feedback</Sub>
                <p className="!mt-1 text-xs text-[#59675c]">Shared after {possessive} sessions, newest first.</p>
              </div>
            </div>

            {options && (options.clubs.length > 1 || options.coaches.length > 1 || options.sports.length > 1) && (
              <Disclosure title="Filter feedback" summary="Narrow by club, coach, or sport.">
              <fieldset id={`${idPrefix}-feedback-filters`}>
                <legend className="sr-only">Filter coach feedback</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  {options.clubs.length > 1 && (
                    <div>
                      <label htmlFor={`${idPrefix}-club`} className="text-xs font-semibold text-[#465e4c]">Club</label>
                      <select id={`${idPrefix}-club`} value={filters.businessSlug ?? ''} onChange={(event) => setFilters(current => ({ ...current, businessSlug: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                        <option value="">All clubs</option>
                        {options.clubs.map(club => <option key={club.slug} value={club.slug}>{club.name}</option>)}
                      </select>
                    </div>
                  )}
                  {options.coaches.length > 1 && (
                    <div>
                      <label htmlFor={`${idPrefix}-coach`} className="text-xs font-semibold text-[#465e4c]">Coach</label>
                      <select id={`${idPrefix}-coach`} value={filters.coach ?? ''} onChange={(event) => setFilters(current => ({ ...current, coach: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                        <option value="">All coaches</option>
                        {options.coaches.map(coach => <option key={coach} value={coach}>{coach}</option>)}
                      </select>
                    </div>
                  )}
                  {options.sports.length > 1 && (
                    <div>
                      <label htmlFor={`${idPrefix}-sport`} className="text-xs font-semibold text-[#465e4c]">Sport</label>
                      <select id={`${idPrefix}-sport`} value={filters.sport ?? ''} onChange={(event) => setFilters(current => ({ ...current, sport: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                        <option value="">All sports</option>
                        {options.sports.map(sport => <option key={sport} value={sport}>{sport}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                {active && (
                  <button type="button" className={cn(compactButton, 'mt-3')} onClick={() => setFilters({})}>Clear feedback filters</button>
                )}
              </fieldset>
              </Disclosure>
            )}

            <p role="status" aria-live="polite" className="text-xs font-medium text-[#59675c]">
              {loading ? 'Updating feedback…' : timeline.length === 1 ? '1 feedback note' : `${timeline.length} feedback notes`}
            </p>
            {error && <ErrorNotice message={error} />}

            {timeline.length ? (
              <>
              <ol className="space-y-3">
                {timeline.slice(0, 3).map(item => (
                  <FeedbackItem
                    key={item.id}
                    item={item}
                    expanded={expanded.has(item.id)}
                    viewed={item.viewed || viewed.has(item.id) || !markViewed}
                    onToggle={() => toggle(item)}
                    headingLevel={headingLevel === 1 ? 3 : 4}
                  />
                ))}
              </ol>
              <ol id={`${idPrefix}-feedback-list`} hidden={!showAllFeedback} start={4} className="space-y-3">
                {timeline.slice(3).map(item => (
                  <FeedbackItem
                    key={item.id}
                    item={item}
                    expanded={expanded.has(item.id)}
                    viewed={item.viewed || viewed.has(item.id) || !markViewed}
                    onToggle={() => toggle(item)}
                    headingLevel={headingLevel === 1 ? 3 : 4}
                  />
                ))}
              </ol>
              {timeline.length > 3 && (
                <SeeMoreButton
                  expanded={showAllFeedback}
                  controls={`${idPrefix}-feedback-list`}
                  hiddenCount={timeline.length - 3}
                  noun="notes"
                  onToggle={() => setShowAllFeedback((value) => !value)}
                  className="w-full"
                />
              )}
              </>
            ) : (
              <EmptyState
                headingLevel={headingLevel === 1 ? 2 : 3}
                icon={<MessageSquareText size={23} />}
                title={active ? 'No feedback matches these filters' : 'No coach feedback yet'}
                action={active ? <button type="button" className={secondaryButton} onClick={() => setFilters({})}>Clear feedback filters</button> : emptyAction}
              >
                {active
                  ? 'Try another club, coach or sport.'
                  : `Coaches can share notes after sessions ${subjectName ? `${subjectName} attends` : 'you attend'}. They will appear here.`}
              </EmptyState>
            )}
          </section>
        </>
      )}
    </div>
  );
}
