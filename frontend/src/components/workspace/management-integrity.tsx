'use client';

import { useState } from 'react';
import { CircleCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { mutate } from '@/lib/api';
import type { IntegrityFlag } from '@/lib/types';
import { shortDate } from '@/lib/utils';

const statusLabels: Record<IntegrityFlag['status'], string> = {
  OPEN: 'Open',
  REVIEWING: 'Reviewing',
  DISMISSED: 'Dismissed',
  UPHELD: 'Upheld',
};

const statusBadges: Record<IntegrityFlag['status'], string> = {
  OPEN: 'badge pending',
  REVIEWING: 'badge',
  DISMISSED: 'badge completed',
  UPHELD: 'badge cancelled',
};

export function IntegrityAlertDetail({ flag, refresh, onResolved, actionable = true }: {
  flag: IntegrityFlag;
  refresh: () => Promise<void>;
  onResolved: () => void;
  actionable?: boolean;
}) {
  const [busyStatus, setBusyStatus] = useState<IntegrityFlag['status'] | null>(null);

  async function resolve(status: IntegrityFlag['status'], promptText?: string) {
    let note = '';
    if (promptText) {
      const answer = window.prompt(promptText, '');
      if (answer === null) return;
      note = answer;
    }
    setBusyStatus(status);
    try {
      await mutate(`/integrity-flags/${encodeURIComponent(flag.id)}`, 'PATCH', { status, note });
      await refresh();
      toast.success(`Flag marked ${statusLabels[status].toLowerCase()}`);
      onResolved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyStatus(null);
    }
  }

  const busy = busyStatus !== null;
  return <div className="mt-5 border-t border-[#edf0e8] pt-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#294735]">{flag.coachName} &amp; {flag.studentName}</p>
        <p className="mt-1 text-[11px] text-stone-500">
          First seen {shortDate(flag.firstSeenAt)} · {flag.occurrences} private session{flag.occurrences === 1 ? '' : 's'} noticed
        </p>
      </div>
      <span className={statusBadges[flag.status]}>{statusLabels[flag.status]}</span>
    </div>
    <p className="mt-4 text-xs leading-relaxed text-stone-600">{flag.detail}</p>
    {flag.flaggedSessionAt && <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
      Most recent private session: {flag.flaggedServiceName || 'Lesson'} on {shortDate(flag.flaggedSessionAt)} at {flag.outsideBusinessName || 'another workspace'}.
    </p>}
    {flag.resolutionNote && <p className="mt-3 border-l-2 border-[#dfe7d3] pl-3 text-[11px] leading-relaxed text-stone-500">
      Your note: {flag.resolutionNote}
    </p>}
    {flag.status === 'DISMISSED' || flag.status === 'UPHELD' ? (
      <p className="mt-4 text-[11px] leading-relaxed text-[#59675c]">This review has been closed. Courtly did not block the booking or notify the coach or student.</p>
    ) : !actionable ? (
      <p className="mt-4 text-[11px] leading-relaxed text-[#59675c]">This alert no longer needs action. Use the latest alert for this review.</p>
    ) : <div className="mt-5 flex flex-wrap gap-2">
      {flag.status !== 'REVIEWING' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve('REVIEWING')}>
        {busyStatus === 'REVIEWING' && <Loader2 size={13} className="animate-spin" />}Reviewing
      </Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve('DISMISSED', 'Dismiss this review. What did you find? (optional)')}>
        {busyStatus === 'DISMISSED' ? <Loader2 size={13} className="animate-spin" /> : <CircleCheck size={13} />}Dismiss
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void resolve('UPHELD', 'Uphold this review. What did you conclude?')}>
        {busyStatus === 'UPHELD' && <Loader2 size={13} className="animate-spin" />}Uphold
      </Button>
    </div>}
    <p className="mt-4 text-[10px] leading-relaxed text-[#59675c]">A flag is a prompt to have a conversation, not a finding.</p>
  </div>;
}
