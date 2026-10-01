import { ArrowRight, Flame, MessageSquareText, Target, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { feedbackPreview, hasProgressData, latestFeedback, streakText } from '@/lib/progress';
import type { ProgressSummary } from '@/lib/types';
import { cn, shortDate } from '@/lib/utils';
import { compactButton, eyebrow, panel } from './styles';

/**
 * Home's training snapshot: streak, sessions attended, current goal and the
 * latest coach note, one tap from the full Progress view. A learner with no
 * attended sessions yet gets a short explanation and a next step instead of
 * a card full of zeros.
 */
export function ProgressCard({
  summary,
  loading,
  onOpen,
  emptyAction,
}: {
  summary: ProgressSummary | null;
  loading: boolean;
  onOpen: () => void;
  emptyAction?: ReactNode;
}) {
  if (!summary) {
    return loading ? (
      <div role="status" className={cn(panel, 'mt-7 p-5 text-xs text-[#59675c]')}>Loading your progress…</div>
    ) : null;
  }

  if (!hasProgressData(summary)) {
    return (
      <section aria-labelledby="home-progress-heading" className={cn(panel, 'mt-7 p-5')}>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e2ece8] text-[#3f6b5c]"><TrendingUp size={18} aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className={eyebrow}>Your training</p>
            <h2 id="home-progress-heading" className="!mt-1 text-lg font-semibold tracking-tight">Progress starts with your first session</h2>
            <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">
              Sessions you attend, weekly streaks, and notes your coaches share will collect here.
            </p>
          </div>
        </div>
        {emptyAction && <div className="mt-4 flex flex-wrap gap-2">{emptyAction}</div>}
      </section>
    );
  }

  const note = latestFeedback(summary.feedback);
  const goal = summary.currentGoal;
  return (
    <section data-tour="student-progress" aria-labelledby="home-progress-heading" className={cn(panel, 'mt-7 p-5')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={eyebrow}>Your training</p>
          <h2 id="home-progress-heading" className="!mt-1 text-lg font-semibold tracking-tight">Progress</h2>
        </div>
        <button type="button" className={compactButton} onClick={onOpen}>
          View progress <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-[#f4f7f0] p-3">
        <div>
          <dt className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[#59675c]"><Flame size={12} aria-hidden="true" /> Streak</dt>
          <dd className="mt-1 text-sm font-semibold text-[#34533e]">{streakText(summary.stats.currentStreakWeeks)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-[#59675c]">Sessions attended</dt>
          <dd className="mt-1 text-sm font-semibold text-[#34533e]">{summary.stats.attended}</dd>
        </div>
      </dl>
      {goal && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-[#e4e9df] p-3">
          <Target size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[#3f6b5c]" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#59675c]">Current goal</p>
            <p className="!mt-1 text-sm text-[#304b39]">{goal.text}</p>
            <p className="!mt-1 text-[11px] text-[#59675c]">Set by {goal.coachName} · {goal.businessName}</p>
          </div>
        </div>
      )}
      {note && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-[#e4e9df] p-3">
          <MessageSquareText size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[#3f6b5c]" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#59675c]">Latest coach note</p>
            <p className="!mt-1 text-sm text-[#304b39]">{feedbackPreview(note)}</p>
            <p className="!mt-1 text-[11px] text-[#59675c]">
              {note.coachName} · {note.serviceName} · {shortDate(note.sessionStartAt, note.timezone)}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
