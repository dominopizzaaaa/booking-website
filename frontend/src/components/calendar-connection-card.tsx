'use client';

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CalendarDays, Check, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  beginGoogleCalendarConnection,
  disconnectGoogleCalendar,
  loadCalendarConnection,
  syncGoogleCalendar,
  updateCalendarConnection,
} from '@/lib/api';
import type { AccountType, CalendarConnectionStatus, CalendarReturnTo } from '@/lib/types';
import { cn } from '@/lib/utils';

type CalendarConnectionCardProps = {
  accountType: AccountType;
  returnTo: CalendarReturnTo;
  className?: string;
};

type PendingAction = 'connect' | 'sync' | 'syncEnabled' | 'busyCheckEnabled' | 'disconnect' | null;

function dateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-SG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function disconnectedStatus(previous: CalendarConnectionStatus): CalendarConnectionStatus {
  return {
    ...previous,
    state: 'DISCONNECTED',
    connected: false,
    email: null,
    calendarName: null,
    syncEnabled: false,
    busyCheckEnabled: false,
    connectedAt: null,
    lastSyncedAt: null,
    lastBusyAt: null,
    busyCacheExpiresAt: null,
    error: null,
  };
}

function statusCopy(status: CalendarConnectionStatus) {
  if (status.state === 'ACTIVE' && status.error) {
    return { label: 'Sync needs attention', description: 'The connection is active, but the latest Google Calendar sync needs attention.' };
  }
  switch (status.state) {
    case 'ACTIVE':
      return { label: 'Connected', description: 'Courtly can keep confirmed lessons visible in Google Calendar.' };
    case 'REAUTH_REQUIRED':
      return { label: 'Reconnect required', description: 'Google needs your permission again before Courtly can continue syncing.' };
    case 'ERROR':
      return { label: 'Connection needs attention', description: 'Courtly could not finish the latest Google Calendar operation.' };
    case 'DISCONNECTING':
      return { label: 'Disconnecting', description: 'Courtly is finishing the disconnect. Your bookings remain unchanged.' };
    default:
      return { label: 'Not connected', description: 'Keep confirmed Courtly lessons alongside your other commitments.' };
  }
}

function PreferenceSwitch({
  id,
  checked,
  disabled,
  label,
  description,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return <div className="flex flex-col gap-3 rounded-xl border border-[#e4e9e1] bg-[#fafbf8] p-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0">
      <p id={id} className="text-xs font-semibold text-[#344b39]">{label}</p>
      <p id={descriptionId} className="mt-1 text-[11px] leading-relaxed text-stone-500">{description}</p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id}
      aria-describedby={descriptionId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-full border px-2.5 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto',
        checked ? 'border-[#b9caae] bg-[#e9f1e3] text-[#48623f]' : 'border-stone-200 bg-white text-stone-500',
      )}
    >
      <span aria-hidden="true" className={cn('relative h-5 w-9 rounded-full transition', checked ? 'bg-[#648258]' : 'bg-stone-300')}>
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {checked ? 'On' : 'Off'}
    </button>
  </div>;
}

/** Account-wide Google Calendar controls shared by student and coach profiles. */
export function CalendarConnectionCard({ accountType, returnTo, className }: CalendarConnectionCardProps) {
  const headingId = useId();
  const syncLabelId = useId();
  const busyLabelId = useId();
  const [status, setStatus] = useState<CalendarConnectionStatus | null>(null);
  const [loading, setLoading] = useState(accountType !== 'CLUB');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<PendingAction>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function load() {
    if (accountType === 'CLUB') return;
    setLoading(true);
    setLoadError('');
    try {
      setStatus(await loadCalendarConnection());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Google Calendar status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    if (accountType === 'CLUB') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    loadCalendarConnection()
      .then(value => { if (active) setStatus(value); })
      .catch(cause => {
        if (active) setLoadError(cause instanceof Error ? cause.message : 'Google Calendar status could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountType]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('calendar');
    if (result !== 'connected' && result !== 'error') return;
    const message = result === 'connected'
      ? 'Google Calendar connected.'
      : 'Google Calendar could not be connected. Try again.';
    setAnnouncement(message);
    if (result === 'connected') toast.success(message);
    else toast.error(message);
    url.searchParams.delete('calendar');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (result === 'connected' && accountType !== 'CLUB') void load();
  }, [accountType]);

  async function connect() {
    if (pending) return;
    setPending('connect');
    setActionError('');
    try {
      const { authorizationUrl } = await beginGoogleCalendarConnection(returnTo);
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Google Calendar could not be opened.');
      setPending(null);
    }
  }

  async function updatePreference(key: 'syncEnabled' | 'busyCheckEnabled', value: boolean) {
    if (pending) return;
    setPending(key);
    setActionError('');
    try {
      const next = await updateCalendarConnection({ [key]: value });
      setStatus(next);
      const subject = key === 'syncEnabled' ? 'Calendar sync' : 'Google busy-time checks';
      const message = `${subject} turned ${value ? 'on' : 'off'}.`;
      setAnnouncement(message);
      toast.success(message);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The calendar preference could not be saved.');
    } finally {
      setPending(null);
    }
  }

  async function syncNow() {
    if (pending) return;
    setPending('sync');
    setActionError('');
    try {
      setStatus(await syncGoogleCalendar());
      setAnnouncement('Google Calendar sync queued.');
      toast.success('Google Calendar sync queued');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Google Calendar could not be synced.');
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    if (pending || !status) return;
    setPending('disconnect');
    setActionError('');
    try {
      const next = await disconnectGoogleCalendar();
      const nextStatus = next ?? disconnectedStatus(status);
      const disconnectQueued = nextStatus.state === 'DISCONNECTING';
      const message = disconnectQueued ? 'Google Calendar disconnect queued.' : 'Google Calendar disconnected.';
      setStatus(nextStatus);
      setConfirmDisconnect(false);
      setAnnouncement(message);
      toast.success(disconnectQueued ? 'Google Calendar disconnect queued' : 'Google Calendar disconnected');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Google Calendar could not be disconnected.');
    } finally {
      setPending(null);
    }
  }

  const baseClass = 'min-w-0 rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6';

  if (accountType === 'CLUB') {
    return <section className={cn(baseClass, className)} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]" aria-hidden="true"><CalendarDays size={18} /></span>
          <div><h2 id={headingId} className="text-sm font-semibold text-[#294735]">Google Calendar</h2><p className="mt-1 text-[11px] leading-relaxed text-stone-500">Personal calendar connection</p></div>
        </div>
        <span className="badge bg-stone-100! text-stone-600!">Individual accounts only</span>
      </div>
      <p className="mt-5 text-xs leading-relaxed text-stone-600">A club account represents the club, not a person, so it cannot connect a personal Google Calendar. Each coach connects their own calendar from their Courtly profile.</p>
    </section>;
  }

  return <section className={cn(baseClass, className)} aria-labelledby={headingId} aria-busy={loading || !!pending}>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]" aria-hidden="true"><CalendarDays size={18} /></span>
        <div className="min-w-0"><h2 id={headingId} className="text-sm font-semibold text-[#294735]">Google Calendar</h2><p className="mt-1 text-[11px] leading-relaxed text-stone-500">This personal connection follows your Courtly account.</p></div>
      </div>
      {status && <span className={cn('badge', status.state === 'ACTIVE' && !status.error ? 'bg-[#e8f1e1]! text-[#4d6844]!' : status.state === 'REAUTH_REQUIRED' || status.state === 'ERROR' || !!status.error ? 'pending' : 'bg-stone-100! text-stone-600!')}>{statusCopy(status).label}</span>}
    </div>

    {loading ? <div role="status" className="mt-6 flex min-h-24 items-center justify-center gap-2 text-xs text-stone-500"><Loader2 size={15} className="animate-spin" />Checking Google Calendar…</div>
      : loadError ? <div className="mt-5 rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-4"><p role="alert" className="text-xs leading-relaxed text-[#8b4d3c]">{loadError}</p><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}><RefreshCw size={13} />Try again</Button></div>
      : status ? <div className="mt-5">
        {!status.configured ? <div className="space-y-4">
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-xs font-semibold text-stone-700">Google Calendar is not available</p><p className="mt-1 text-[11px] leading-relaxed text-stone-500">This Courtly deployment has not configured Google Calendar yet. Your Courtly schedule continues to work normally.</p></div>
            {status.state !== 'DISCONNECTED' && <div className="rounded-xl border border-[#e4e9e1] p-4">
              <p className="text-xs font-semibold text-[#344b39]">{status.state === 'DISCONNECTING' ? 'Disconnect pending' : 'A saved connection still exists'}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-stone-500">{status.state === 'DISCONNECTING' ? 'Courtly is removing the saved Google connection. Your bookings remain unchanged.' : 'Connection features are unavailable, but you can remove the saved Google connection from Courtly.'}</p>
              {status.email && <p className="mt-2 break-all text-[10px] font-semibold text-[#405941]">{status.email}</p>}
              {status.state !== 'DISCONNECTING' && <Button type="button" variant="ghost" className="mt-3 w-full text-[#8b4d3c] sm:w-auto" disabled={!!pending} onClick={() => { setActionError(''); setConfirmDisconnect(true); }}><Unplug size={14} />Disconnect</Button>}
            </div>}
          </div>
          : !status.eligible ? <div className="rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-xs font-semibold text-stone-700">This account cannot connect a calendar</p><p className="mt-1 text-[11px] leading-relaxed text-stone-500">Google Calendar is available to eligible personal Courtly accounts.</p></div>
          : <>
            <div className="flex items-start gap-3">
              <span className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full', status.state === 'ACTIVE' && !status.error ? 'bg-[#e8f1e1] text-[#507047]' : status.state === 'REAUTH_REQUIRED' || status.state === 'ERROR' || !!status.error ? 'bg-amber-50 text-amber-700' : 'bg-stone-100 text-stone-500')} aria-hidden="true">
                {status.state === 'ACTIVE' && !status.error ? <Check size={15} /> : status.state === 'REAUTH_REQUIRED' || status.state === 'ERROR' || !!status.error ? <AlertTriangle size={15} /> : status.state === 'DISCONNECTING' ? <Loader2 size={15} className="animate-spin" /> : <Unplug size={15} />}
              </span>
              <div className="min-w-0"><p className="text-xs font-semibold text-[#344b39]">{statusCopy(status).label}</p><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{statusCopy(status).description}</p></div>
            </div>

            {(status.email || status.calendarName) && <dl className="mt-4 grid gap-3 rounded-xl bg-[#f5f7f1] p-4 text-[11px] sm:grid-cols-2">
              {status.email && <div><dt className="text-stone-500">Google account</dt><dd className="mt-1 break-all font-semibold text-[#405941]">{status.email}</dd></div>}
              {status.calendarName && <div><dt className="text-stone-500">Calendar</dt><dd className="mt-1 break-all font-semibold text-[#405941]">{status.calendarName}</dd></div>}
            </dl>}

            {status.state === 'ERROR' && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">{status.error || 'Google Calendar reported a problem. Reconnect to restore the connection.'}</p>}
            {status.state === 'REAUTH_REQUIRED' && status.error && <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">{status.error}</p>}
            {status.state === 'ACTIVE' && status.error && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">{status.error}</p>}

            {status.state !== 'DISCONNECTED' && status.state !== 'DISCONNECTING' && <div className="mt-5 space-y-3">
              <PreferenceSwitch id={syncLabelId} checked={status.syncEnabled} disabled={!!pending} label="Sync Courtly lessons" description="Add and update confirmed Courtly lessons in this Google Calendar." onChange={checked => void updatePreference('syncEnabled', checked)} />
              <PreferenceSwitch id={busyLabelId} checked={status.busyCheckEnabled} disabled={!!pending} label="Check Google busy times" description="Use cached busy times from Google when Courtly checks your availability. Event details stay private." onChange={checked => void updatePreference('busyCheckEnabled', checked)} />
            </div>}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {status.state === 'DISCONNECTED' && <Button type="button" className="w-full sm:w-auto" disabled={!!pending} onClick={() => void connect()}>{pending === 'connect' && <Loader2 size={14} className="animate-spin" />}{pending === 'connect' ? 'Opening Google…' : 'Connect Google Calendar'}</Button>}
              {(status.state === 'REAUTH_REQUIRED' || status.state === 'ERROR') && <Button type="button" className="w-full sm:w-auto" disabled={!!pending} onClick={() => void connect()}>{pending === 'connect' && <Loader2 size={14} className="animate-spin" />}{pending === 'connect' ? 'Opening Google…' : 'Reconnect Google Calendar'}</Button>}
              {status.state === 'ACTIVE' && <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={!!pending || !status.syncEnabled} onClick={() => void syncNow()}>{pending === 'sync' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{pending === 'sync' ? 'Syncing…' : 'Sync now'}</Button>}
              {status.state !== 'DISCONNECTED' && status.state !== 'DISCONNECTING' && <Button type="button" variant="ghost" className="w-full text-[#8b4d3c] sm:w-auto" disabled={!!pending} onClick={() => { setActionError(''); setConfirmDisconnect(true); }}><Unplug size={14} />Disconnect</Button>}
            </div>

            {(dateTime(status.lastSyncedAt) || dateTime(status.lastBusyAt)) && <p className="mt-4 text-[10px] leading-relaxed text-stone-500">{dateTime(status.lastSyncedAt) && `Last synced ${dateTime(status.lastSyncedAt)}.`}{dateTime(status.lastSyncedAt) && dateTime(status.lastBusyAt) ? ' ' : ''}{dateTime(status.lastBusyAt) && `Busy times last checked ${dateTime(status.lastBusyAt)}.`}</p>}
          </>}
      </div> : null}

    <p className="mt-5 rounded-xl bg-[#f5f7f1] p-3 text-[10px] leading-relaxed text-stone-600"><strong className="font-semibold text-[#405941]">Courtly stays authoritative.</strong> Editing or deleting a Google event never changes the Courtly booking.</p>
    {actionError && !confirmDisconnect && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-700">{actionError}</p>}

    <Dialog open={confirmDisconnect} onOpenChange={open => { if (pending !== 'disconnect') { setConfirmDisconnect(open); if (!open) setActionError(''); } }}>
      <DialogContent onEscapeKeyDown={event => { if (pending === 'disconnect') event.preventDefault(); }} onPointerDownOutside={event => { if (pending === 'disconnect') event.preventDefault(); }}>
        <DialogTitle className="text-lg font-semibold text-[#294735]">Disconnect Google Calendar?</DialogTitle>
        <DialogDescription className="mt-3 text-xs leading-relaxed text-stone-500">Courtly will stop syncing lessons and checking Google busy times. Your Courtly bookings will not change, and existing Google events may remain in your calendar.</DialogDescription>
        {actionError && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-700">{actionError}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-[#edf0e8] pt-5 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={pending === 'disconnect'} onClick={() => { setActionError(''); setConfirmDisconnect(false); }}>Keep connected</Button>
          <Button type="button" variant="destructive" disabled={pending === 'disconnect'} onClick={() => void disconnect()}>{pending === 'disconnect' && <Loader2 size={14} className="animate-spin" />}{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google Calendar'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
