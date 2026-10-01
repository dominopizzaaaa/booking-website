'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ArrowRight, Loader2, Sprout } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadGrowthInsights } from '@/lib/api';
import type { GrowthInsights as GrowthInsightsData } from '@/lib/types';
import {
  busiestDay, dailyBars, dailyTotal, formatRate, funnelSteps, growthPeriods, growthRates, rate,
  type DailyMetric, type GrowthPeriod,
} from '@/lib/insights';
import { cn, shortDateKey } from '@/lib/utils';

const metricLabels: Record<DailyMetric, string> = {
  pageViews: 'Booking page views', availabilityChecks: 'Availability checks', bookings: 'Bookings',
};

/**
 * Club growth: how people find, check and book, and whether they come back.
 *
 * The funnel numbers are anonymous daily counters. Nothing on this screen can
 * be traced to a visitor, account or device, and the copy says so plainly so
 * a club never mistakes it for tracking.
 */
export function GrowthInsights() {
  const [days, setDays] = useState<GrowthPeriod>(30);
  const [metric, setMetric] = useState<DailyMetric>('pageViews');
  const [insights, setInsights] = useState<GrowthInsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showTable, setShowTable] = useState(false);
  const chartTitleId = useId();
  const chartDescriptionId = useId();
  const tableId = useId();

  const load = useCallback(async (period: GrowthPeriod) => {
    setLoading(true);
    setError('');
    try {
      setInsights(await loadGrowthInsights(period));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Growth insights could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days); }, [days, load]);

  const steps = insights ? funnelSteps(insights.funnel) : [];
  const rates = insights ? growthRates(insights) : null;
  const bars = insights ? dailyBars(insights.daily, metric) : [];
  const total = insights ? dailyTotal(insights.daily, metric) : 0;
  const busiest = insights ? busiestDay(insights.daily, metric) : null;
  const chartSummary = insights
    ? `${metricLabels[metric]} per day over the last ${insights.days} days: ${total} in total${busiest ? `, busiest on ${shortDateKey(busiest.day)} with ${busiest.value}` : ', none recorded yet'}.`
    : '';

  return <section className="mb-5" aria-labelledby="growth-insights-heading">
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id="growth-insights-heading" className="text-base text-[#294735]">Growth</h2>
        <p className="!mt-1 max-w-2xl text-xs leading-relaxed text-[#59675c]">How people find your booking page, check times, book and come back. Page views, availability checks and search impressions are anonymous daily totals: no visitor, account or device is recorded.</p>
      </div>
      <div className="tab-bar w-full sm:w-fit" role="group" aria-label="Growth reporting period">
        {growthPeriods.map(period => <button key={period} type="button" aria-pressed={days === period} className={cn('min-h-10 flex-1 sm:flex-none', days === period && 'active')} onClick={() => setDays(period)}>{period} days</button>)}
      </div>
    </div>

    <div aria-live="polite" aria-busy={loading}>
      {loading && !insights ? <div className="panel flex min-h-48 items-center justify-center gap-2 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Loading growth insights…</div>
        : error ? <div className="panel flex min-h-40 flex-col items-center justify-center gap-3 p-5 text-center"><p role="alert" className="text-xs text-red-700">{error}</p><Button size="sm" variant="outline" onClick={() => void load(days)}>Try again</Button></div>
          : insights && rates ? <div className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
            <section className="panel overflow-hidden" aria-labelledby="growth-funnel-heading">
              <div className="panel-heading flex-wrap"><div><h3 id="growth-funnel-heading" className="text-sm text-[#294735]">Booking funnel</h3><p className="!mt-1 text-[11px] text-[#59675c]">Last {insights.days} days · conversion from the step before</p></div></div>
              <ol className="grid gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-5 sm:pb-5">
                {steps.map((step, index) => <li key={step.id} className="relative rounded-xl bg-[#f5f7f1] p-4">
                  <p className="text-[11px] font-medium text-[#59675c]">{step.label}</p>
                  <p className="!mt-1 text-2xl font-semibold tracking-tight text-[#254b38]">{step.value.toLocaleString('en-SG')}</p>
                  <p className="!mt-1 flex items-center gap-1 text-[11px] text-[#59675c]">{index === 0 ? 'Starting point' : <><ArrowRight size={12} aria-hidden="true" /><span>{formatRate(step.fromPrevious)} of the previous step</span></>}</p>
                </li>)}
              </ol>
              <dl className="grid grid-cols-2 gap-px border-t border-[#edf0e8] bg-[#edf0e8] sm:grid-cols-4">
                <Metric label="View to booking" value={formatRate(rates.viewToBooking)} detail="Bookings ÷ page views" />
                <Metric label="Rebooks" value={insights.funnel.rebooks.toLocaleString('en-SG')} detail={`${formatRate(rates.rebookShare)} of bookings`} />
                <Metric label="Waitlist" value={`${insights.funnel.waitlistJoined} joined`} detail={`${insights.funnel.waitlistAccepted} accepted · ${formatRate(rates.waitlistAcceptance)}`} />
                <Metric label="Search impressions" value={insights.funnel.searchImpressions.toLocaleString('en-SG')} detail="Times you appeared in Find a time" />
              </dl>
            </section>

            <section className="panel overflow-hidden" aria-labelledby="growth-daily-heading">
              <div className="panel-heading flex-wrap">
                <div><h3 id="growth-daily-heading" className="text-sm text-[#294735]">Daily activity</h3><p className="!mt-1 text-[11px] text-[#59675c]">{metricLabels[metric]} · {total.toLocaleString('en-SG')} in total</p></div>
                <label className="mb-0 w-full sm:w-auto"><span className="sr-only">Daily metric</span><select value={metric} onChange={event => setMetric(event.target.value as DailyMetric)} className="text-xs sm:max-w-56">{(Object.keys(metricLabels) as DailyMetric[]).map(key => <option key={key} value={key}>{metricLabels[key]}</option>)}</select></label>
              </div>
              <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                <svg role="img" aria-labelledby={`${chartTitleId} ${chartDescriptionId}`} viewBox={`0 0 ${Math.max(1, bars.length) * 10} 64`} preserveAspectRatio="none" className="block h-28 w-full">
                  <title id={chartTitleId}>{`Daily ${metricLabels[metric].toLowerCase()}`}</title>
                  <desc id={chartDescriptionId}>{chartSummary}</desc>
                  <line x1="0" x2={bars.length * 10} y1="63.5" y2="63.5" stroke="#cfd8c8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  {bars.map((bar, index) => bar.value > 0 && <rect key={bar.day} x={index * 10 + 1.5} width="7" y={63 - bar.height * 60} height={bar.height * 60} rx="1.5" fill={index === bars.length - 1 ? '#3f6a3d' : '#6f8d62'} />)}
                </svg>
                <div className="mt-2 flex justify-between text-[11px] text-[#59675c]" aria-hidden="true"><span>{bars[0] ? shortDateKey(bars[0].day) : ''}</span><span>{bars.length ? shortDateKey(bars[bars.length - 1].day) : ''}</span></div>
                <p className="!mt-2 text-[11px] leading-relaxed text-[#59675c]">{chartSummary}</p>
                <Button type="button" size="sm" variant="ghost" className="mt-1 -ml-2" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable(value => !value)}>{showTable ? 'Hide daily numbers' : 'Show daily numbers'}</Button>
                {showTable && <div id={tableId} className="mt-2 max-h-72 overflow-auto rounded-lg border border-[#edf0e8]" tabIndex={0} role="region" aria-label="Daily numbers">
                  <table className="data-table"><thead><tr><th scope="col">Day</th><th scope="col">Page views</th><th scope="col">Availability checks</th><th scope="col">Bookings</th></tr></thead>
                    <tbody>{[...insights.daily].reverse().map(day => <tr key={day.day}><th scope="row" className="font-medium">{shortDateKey(day.day)}</th><td>{day.pageViews}</td><td>{day.availabilityChecks}</td><td>{day.bookings}</td></tr>)}</tbody></table>
                </div>}
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="panel overflow-hidden" aria-labelledby="growth-retention-heading">
                <div className="panel-heading"><h3 id="growth-retention-heading" className="text-sm text-[#294735]">Retention</h3></div>
                <dl className="grid grid-cols-3 gap-px border-t border-[#edf0e8] bg-[#edf0e8]">
                  <Metric label="Active students" value={insights.retention.activeStudents.toLocaleString('en-SG')} detail="With a place in this period" />
                  <Metric label="Returning" value={insights.retention.returningStudents.toLocaleString('en-SG')} detail="Two or more places" />
                  <Metric label="Repeat rate" value={formatRate(insights.retention.repeatRate ?? rate(insights.retention.returningStudents, insights.retention.activeStudents))} detail="Returning ÷ active" />
                </dl>
              </section>
              <section className="panel overflow-hidden" aria-labelledby="growth-feedback-heading">
                <div className="panel-heading"><h3 id="growth-feedback-heading" className="text-sm text-[#294735]">Coach feedback</h3></div>
                <dl className="grid grid-cols-2 gap-px border-t border-[#edf0e8] bg-[#edf0e8]">
                  <Metric label="Coverage" value={formatRate(insights.feedback.coverage ?? rate(insights.feedback.withSharedFeedback, insights.feedback.attendedPlaces))} detail={`${insights.feedback.withSharedFeedback} of ${insights.feedback.attendedPlaces} attended places got shared feedback`} />
                  <Metric label="Read by learners" value={formatRate(insights.feedback.viewRate ?? rate(insights.feedback.viewed, insights.feedback.withSharedFeedback))} detail={`${insights.feedback.viewed} opened`} />
                </dl>
              </section>
              <section className="panel overflow-hidden" aria-labelledby="growth-waitlist-heading">
                <div className="panel-heading"><h3 id="growth-waitlist-heading" className="text-sm text-[#294735]">Waitlists right now</h3></div>
                <dl className="grid grid-cols-2 gap-px border-t border-[#edf0e8] bg-[#edf0e8]">
                  <Metric label="Waiting" value={insights.waitlist.waiting.toLocaleString('en-SG')} detail="Queued for a full Class" />
                  <Metric label="Offered" value={insights.waitlist.offered.toLocaleString('en-SG')} detail="Holding a place to accept" />
                </dl>
              </section>
            </div>
            {!insights.funnel.pageViews && !insights.funnel.bookings && <p className="flex items-start gap-2 rounded-xl bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]"><Sprout size={15} className="mt-0.5 shrink-0" aria-hidden="true" />Share your booking link to start the funnel. Numbers appear here as people visit and book.</p>}
          </div> : null}
    </div>
  </section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 bg-white p-4">
    <dt className="text-[11px] font-medium text-[#59675c]">{label}</dt>
    <dd className="mt-1 text-lg font-semibold tracking-tight text-[#254b38]">{value}</dd>
    <dd className="mt-1 text-[11px] leading-snug text-[#59675c]">{detail}</dd>
  </div>;
}
