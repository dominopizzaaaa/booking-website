'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { History, Loader2, ShieldCheck } from 'lucide-react';
import { loadAuditEvents } from '@/lib/api';
import type { AuditAccessSnapshot, AuditEvent } from '@/lib/types';
import { Button } from '@/components/ui/button';

const actionLabels: Record<string, string> = {
  STAFF_INVITATION_CREATED: 'Staff invitation created',
  STAFF_INVITATION_ACCEPTED: 'Staff invitation accepted',
  STAFF_INVITATION_REVOKED: 'Staff invitation revoked',
  STAFF_ACCESS_UPDATED: 'Staff access updated',
  STAFF_ACCESS_REVOKED: 'Staff access revoked',
};

const resourceLabels: Record<string, string> = {
  ClubStaffAccess: 'Staff access',
  ClubStaffInvitation: 'Staff invitation',
};

function readable(value: string) {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./u, letter => letter.toUpperCase());
}

function actorRole(event: AuditEvent) {
  if (event.actor.accessKind === 'CLUB_ACCOUNT') return 'Club account';
  if (event.actor.accessKind === 'CLUB_STAFF') {
    return event.actor.accessLevel ? readable(event.actor.accessLevel) + ' staff' : 'Named staff';
  }
  return readable(event.actor.accessKind || event.actor.accountType);
}

function Snapshot({ value, label }: { value: AuditAccessSnapshot; label?: string }) {
  const permissions = value.permissions?.map(readable) ?? [];
  if (!value.accessLevel && !permissions.length) return null;
  return <div className="rounded-lg bg-[#f7f8f5] px-3 py-2 text-[10px] leading-relaxed text-[#59675c]">
    {label && <span className="mr-1 font-semibold text-[#405744]">{label}:</span>}
    {value.accessLevel && <span>{readable(value.accessLevel)}</span>}
    {value.accessLevel && permissions.length ? <span> · </span> : null}
    {permissions.length ? <span>{permissions.join(', ')}</span> : null}
  </div>;
}

function EventMetadata({ event }: { event: AuditEvent }) {
  if (event.metadata.before || event.metadata.after) {
    return <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {event.metadata.before && <Snapshot label="Before" value={event.metadata.before} />}
      {event.metadata.after && <Snapshot label="After" value={event.metadata.after} />}
    </div>;
  }
  return <div className="mt-3"><Snapshot value={event.metadata} /></div>;
}

export function AuditLog({ timezone }: { timezone: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await loadAuditEvents({ limit: 25 });
      setEvents(result.events);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Audit history could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);

  async function loadOlder() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const result = await loadAuditEvents({ cursor: nextCursor, limit: 25 });
      setEvents(current => {
        const known = new Set(current.map(event => event.id));
        return [...current, ...result.events.filter(event => !known.has(event.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Older audit history could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }

  return <section className="panel overflow-hidden" aria-labelledby="audit-log-heading" aria-busy={loading || loadingMore}>
    <div className="panel-heading items-start gap-4">
      <div>
        <h2 id="audit-log-heading" className="text-[#294735]">Audit log</h2>
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-stone-500">A read-only history of sensitive club access changes, with the authority held by each actor at the time.</p>
      </div>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]" aria-hidden="true"><ShieldCheck size={17} /></span>
    </div>

    {loading ? <div className="flex items-center justify-center gap-2 px-5 py-14 text-xs text-stone-500" role="status"><Loader2 size={15} className="animate-spin" />Loading audit history…</div>
      : !events.length && !error ? <div className="px-5 py-14 text-center"><History size={24} className="mx-auto text-[#a8b3a2]" aria-hidden="true" /><h3 className="mt-3 text-sm font-semibold text-[#405744]">No recorded activity yet</h3><p className="mt-2 text-xs text-stone-500">Sensitive club access changes will appear here.</p></div>
        : <ol className="divide-y divide-[#edf0e8]" aria-label="Club audit events">
          {events.map(event => <li key={event.id} className="px-4 py-4 sm:px-6 sm:py-5">
            <article aria-labelledby={'audit-summary-' + event.id} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#74806f]">{actionLabels[event.action] ?? readable(event.action)}</p>
                <h3 id={'audit-summary-' + event.id} className="mt-1.5 break-words text-sm font-semibold leading-relaxed text-[#294735]">{event.summary}</h3>
                <p className="mt-2 text-[11px] leading-relaxed text-stone-500"><span className="font-medium text-[#405744]">{event.actor.name}</span> · {actorRole(event)}</p>
                {event.actor.permissions.length > 0 && <details className="mt-2 text-[10px] text-stone-500"><summary className="cursor-pointer rounded-sm text-[#59675c] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#718b65]">Authority at the time</summary><p className="mt-1.5 leading-relaxed">{event.actor.permissions.map(readable).join(', ')}</p></details>}
                <EventMetadata event={event} />
              </div>
              <div className="sm:min-w-40 sm:text-right">
                <time dateTime={event.createdAt} className="block text-[11px] font-medium text-[#59675c]">{formatInTimeZone(event.createdAt, timezone, 'd MMM yyyy')}</time>
                <span className="mt-1 block text-[10px] text-stone-400">{formatInTimeZone(event.createdAt, timezone, 'h:mm a zzz')}</span>
                <span className="mt-3 block break-all text-[9px] text-stone-400">{resourceLabels[event.resource.type] ?? readable(event.resource.type)}{event.resource.id ? ' · ' + event.resource.id : ''}</span>
              </div>
            </article>
          </li>)}
        </ol>}

    {error && <div className="border-t border-[#f1e4df] bg-[#fff8f5] px-4 py-3 sm:px-6" role="alert"><p className="text-xs text-[#9b4a3c]">{error}</p>{!events.length && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadFirstPage()}>Try again</Button>}</div>}
    {nextCursor && !loading && <div className="border-t border-[#edf0e8] px-4 py-4 text-center sm:px-6"><Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadOlder()}>{loadingMore && <Loader2 size={14} className="animate-spin" />}Load older activity</Button></div>}
  </section>;
}
