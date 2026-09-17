'use client';

import { useState } from 'react';
import { CircleCheck, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { resolveIntegrityFlag } from '@/lib/api';
import type { IntegrityFlag } from '@/lib/types';
import { shortDate } from '@/lib/utils';
import { Empty, PageHeading, Stat, type ManagementProps } from './management-ui';

const statusLabels: Record<IntegrityFlag['status'], string> = {
  OPEN: 'Open',
  REVIEWING: 'Reviewing',
  DISMISSED: 'Nothing to answer',
  UPHELD: 'Upheld',
};

const statusBadges: Record<IntegrityFlag['status'], string> = {
  OPEN: 'badge pending',
  REVIEWING: 'badge',
  DISMISSED: 'badge completed',
  UPHELD: 'badge cancelled',
};

/**
 * The club safeguard, as a review queue.
 *
 * Courtly reports; the club decides. A flag says only that a coach and a
 * student who met through this club now train privately outside it — which has
 * innocent explanations as often as not. Nothing is blocked, nobody is
 * accused, and the club's own note is what closes the matter.
 */
export function IntegrityView({ data, refresh }: ManagementProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const flags = data.integrityFlags.filter(flag =>
    filter === 'all'
      ? true
      : filter === 'open'
        ? flag.status === 'OPEN' || flag.status === 'REVIEWING'
        : flag.status === 'DISMISSED' || flag.status === 'UPHELD');
  const open = data.integrityFlags.filter(flag => flag.status === 'OPEN').length;
  const reviewing = data.integrityFlags.filter(flag => flag.status === 'REVIEWING').length;

  async function resolve(flag: IntegrityFlag, status: IntegrityFlag['status'], promptText?: string) {
    let note = '';
    if (promptText) {
      const answer = window.prompt(promptText, '');
      if (answer === null) return;
      note = answer;
    }
    setBusyId(flag.id);
    try {
      await resolveIntegrityFlag(flag.id, status, note);
      await refresh();
      toast.success(`Flag marked ${statusLabels[status].toLowerCase()}`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return <>
    <PageHeading
      title="Integrity"
      description={`Courtly tells you when a coach and a student who train together through ${data.business.name} also book privately outside it. It reports; you decide what, if anything, it means.`}
    />
    <div className="stat-grid grid-cols-2! sm:grid-cols-3!">
      <Stat label="Open flags" value={open} detail="Not yet looked at" icon={ShieldAlert} />
      <Stat label="Under review" value={reviewing} detail="You marked these as being looked into" icon={Users} />
      <Stat label="Closed" value={data.integrityFlags.filter(flag => flag.resolvedAt).length} detail="Dismissed or upheld" icon={ShieldCheck} />
    </div>

    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e5e9e0] bg-white p-3 sm:px-4">
      <p className="text-xs text-stone-500"><strong className="font-semibold text-[#405941]">{flags.length}</strong> flag{flags.length === 1 ? '' : 's'}</p>
      <select aria-label="Filter flags" value={filter} onChange={event => setFilter(event.target.value as typeof filter)} className="text-xs max-sm:w-full sm:max-w-44">
        <option value="open">Needs a decision</option>
        <option value="resolved">Already closed</option>
        <option value="all">All flags</option>
      </select>
    </div>

    {flags.length ? <div className="space-y-3">
      {flags.map(flag => <article key={flag.id} className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base text-[#294735]">{flag.coachName} &amp; {flag.studentName}</h2>
            <p className="mt-1 text-[11px] text-stone-500">
              First seen {shortDate(flag.firstSeenAt)} · {flag.occurrences} private session{flag.occurrences === 1 ? '' : 's'} noticed
            </p>
          </div>
          <span className={statusBadges[flag.status]}>{statusLabels[flag.status]}</span>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-stone-600">{flag.detail}</p>
        {flag.flaggedSessionAt && <p className="mt-3 text-[11px] text-stone-500">
          Most recent private session: {flag.flaggedServiceName || 'Lesson'} on {shortDate(flag.flaggedSessionAt)} at {flag.outsideBusinessName || 'another workspace'}.
        </p>}
        {flag.resolutionNote && <p className="mt-3 border-l-2 border-[#dfe7d3] pl-3 text-[11px] leading-relaxed text-stone-500">
          Your note: {flag.resolutionNote}
        </p>}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-[#edf0e8] pt-4">
          {flag.status !== 'REVIEWING' && flag.status !== 'DISMISSED' && flag.status !== 'UPHELD' && (
            <Button size="sm" variant="outline" disabled={busyId === flag.id} onClick={() => void resolve(flag, 'REVIEWING')}>
              I&rsquo;m looking into this
            </Button>
          )}
          {flag.status !== 'DISMISSED' && (
            <Button size="sm" variant="outline" disabled={busyId === flag.id} onClick={() => void resolve(flag, 'DISMISSED', 'Close this as nothing to answer. What did you find? (optional)')}>
              <CircleCheck size={13} />Nothing to answer
            </Button>
          )}
          {flag.status !== 'UPHELD' && (
            <Button size="sm" variant="destructive" disabled={busyId === flag.id} onClick={() => void resolve(flag, 'UPHELD', 'Record this as upheld. What did you conclude?')}>
              Uphold this flag
            </Button>
          )}
        </div>
      </article>)}
    </div> : <div className="panel"><Empty title={filter === 'open' ? 'Nothing needs a decision' : 'No flags here'} icon={ShieldCheck}>
      {filter === 'open'
        ? 'Nobody who trains through your club has been seen booking privately with one of your coaches.'
        : 'Flags you have closed will be kept here.'}
    </Empty></div>}

    <p className="mt-4 text-[10px] leading-relaxed text-stone-400">
      A flag is a prompt to have a conversation, not a finding. Courtly does not block the booking, notify the coach or the student, or share your decision with them.
    </p>
  </>;
}
