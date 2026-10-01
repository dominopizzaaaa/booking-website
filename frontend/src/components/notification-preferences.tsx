'use client';

import { useEffect, useId, useState } from 'react';
import { Bell, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadNotificationPreferences, updateNotificationPreferences } from '@/lib/api';
import type { NotificationPreferences } from '@/lib/types';
import { cn } from '@/lib/utils';

type PreferenceKey = keyof NotificationPreferences;
type PendingState = PreferenceKey | 'loading' | null;

const choices: Array<{ key: PreferenceKey; label: string; description: string }> = [
  {
    key: 'emailTransactionalEnabled',
    label: 'Account and booking updates',
    description: 'Essential confirmations and changes related to your Courtly account, bookings, payments, or invitations.',
  },
  {
    key: 'emailReminderEnabled',
    label: 'Booking reminders',
    description: 'Helpful reminders before an upcoming lesson or court booking.',
  },
  {
    key: 'emailActionNeededEnabled',
    label: 'Action-needed alerts',
    description: 'Messages when Courtly needs you to respond, approve a change, or complete a task.',
  },
];

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Notification preferences could not be saved.';
}

export function NotificationPreferencesCard({ className }: { className?: string }) {
  const headingId = useId();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [emailAvailable, setEmailAvailable] = useState(true);
  const [pending, setPending] = useState<PendingState>('loading');
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');

  async function load() {
    setPending('loading');
    setError('');
    try {
      const result = await loadNotificationPreferences();
      setPreferences(result.preferences);
      setEmailAvailable(result.emailAvailable);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(null);
    }
  }

  useEffect(() => { void load(); }, []);

  async function change(key: PreferenceKey, enabled: boolean) {
    if (!preferences || pending) return;
    const previous = preferences;
    const next = { ...preferences, [key]: enabled };
    const choice = choices.find(item => item.key === key)!;
    setPreferences(next);
    setPending(key);
    setError('');
    setAnnouncement('');
    try {
      const result = await updateNotificationPreferences(next);
      setPreferences(result.preferences);
      setEmailAvailable(result.emailAvailable);
      setAnnouncement(`${choice.label} turned ${enabled ? 'on' : 'off'}.`);
    } catch (cause) {
      setPreferences(previous);
      setError(messageOf(cause));
    } finally {
      setPending(null);
    }
  }

  return <section className={cn('panel overflow-hidden', className)} aria-labelledby={headingId} aria-busy={pending === 'loading'}>
    <div className="panel-heading">
      <div className="flex items-center gap-2"><Bell size={17} className="text-[#839677]" aria-hidden="true" /><h2 id={headingId} className="text-[#294735]">Email notifications</h2></div>
    </div>
    <div className="px-5 pb-5 sm:px-6 sm:pb-6">
      <p className="text-xs leading-relaxed text-stone-500">These choices follow your account across every club.</p>
      {pending === 'loading' ? (
        <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-[#f5f7f1] p-4 text-xs text-stone-500"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Loading email preferences…</p>
      ) : error && !preferences ? (
        <div className="mt-4 space-y-3"><p role="alert" className="rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p><Button type="button" size="sm" variant="outline" onClick={() => void load()}><RefreshCw size={13} aria-hidden="true" />Try again</Button></div>
      ) : preferences ? (
        <fieldset className="mt-4 space-y-3" disabled={!!pending}>
          <legend className="sr-only">Email notification choices</legend>
          {choices.map(choice => {
            const labelId = `${headingId}-${choice.key}-label`;
            const descriptionId = `${headingId}-${choice.key}-description`;
            const checked = preferences[choice.key];
            return <div key={choice.key} className="flex flex-col gap-3 rounded-xl border border-[#e4e9e1] bg-[#fafbf8] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><p id={labelId} className="text-xs font-semibold text-[#344b39]">{choice.label}</p><p id={descriptionId} className="mt-1 text-[11px] leading-relaxed text-stone-500">{choice.description}</p></div>
              <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelId} aria-describedby={descriptionId} onClick={() => void change(choice.key, !checked)} className={cn('inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-full border px-2.5 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto', checked ? 'border-[#b9caae] bg-[#e9f1e3] text-[#48623f]' : 'border-stone-200 bg-white text-stone-500')}>
                <span aria-hidden="true" className={cn('relative h-5 w-9 rounded-full transition', checked ? 'bg-[#648258]' : 'bg-stone-300')}><span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all', checked ? 'left-[18px]' : 'left-0.5')} /></span>{pending === choice.key ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : checked ? 'On' : 'Off'}
              </button>
            </div>;
          })}
          {!emailAvailable && <p role="status" className="rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">Email delivery is not available right now. You can still save your choices; they will apply when email is enabled.</p>}
        </fieldset>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {error && preferences && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
    </div>
  </section>;
}
