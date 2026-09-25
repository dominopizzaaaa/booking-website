'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, LockKeyhole, Pencil, Plus, ShieldCheck, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, mutate } from '@/lib/api';
import type { AccountType } from '@/lib/types';
import { initials } from '@/lib/utils';
import { Editor, Empty, Field, errorMessage, numeric, text, type ManagementProps } from './management-ui';

type StaffUser = {
  id: string;
  userId: string;
  name: string;
  email: string;
  accountType: AccountType;
  instructorId: string | null;
  active: boolean;
  createdAt: string;
};

export function StaffAccess(props: ManagementProps) {
  // The club account is the only identity allowed to inspect or change its roster access.
  return props.data.user.accountType === 'CLUB' ? <ClubStaffAccess key={`${props.data.business.id}-${props.data.user.id}`} {...props} /> : null;
}

function ClubStaffAccess({ data, refresh }: ManagementProps) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<StaffUser | null | undefined>();
  const [removing, setRemoving] = useState<StaffUser | null>(null);
  const loadStaff = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const users = await api<StaffUser[]>('/staff', { signal });
      if (!signal?.aborted) setStaff(users);
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadStaff(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [loadStaff]);
  async function refreshAccess() { await Promise.all([loadStaff(), refresh()]); }

  return <section className="mt-10 border-t border-[#e6eae3] pt-8" aria-labelledby="staff-access-heading">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div><p className="eyebrow mb-2">Club controls</p><h2 id="staff-access-heading" className="text-xl">Coach access</h2><p className="mt-2 max-w-xl text-xs leading-relaxed text-stone-500">Connect a coach who already has their own Courtly coach account.</p></div>
      <Button onClick={() => setEditing(null)} disabled={loading || !!error} className="max-sm:w-full"><Plus size={15} />Add coach</Button>
    </div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#e3e9db] bg-[#eff3e9] p-4">
      <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6d7d62]" />
      <div className="space-y-1.5 text-xs leading-relaxed text-[#5c7054]"><p><strong className="font-semibold">Accounts stay personal.</strong> Ask the coach to register first, then find their account by username, email, or exact name. You never create or handle their password.</p><p>Removing access only unlinks this club. Their account, other club memberships, coach profile, and booking history remain intact.</p></div>
    </div>
    <div className="panel overflow-hidden" aria-busy={loading}>
      {loading ? <p role="status" className="flex items-center justify-center gap-2 p-8 text-xs text-stone-500"><Loader2 size={16} className="animate-spin" />Loading staff access…</p> : error ? <div className="space-y-3 p-5"><p role="alert" className="text-xs text-red-700">{error}</p><Button variant="outline" size="sm" onClick={() => { void loadStaff().catch(() => {}); }}>Try again</Button></div> : staff.length ? <ul className="divide-y divide-[#edf0e8]">
        {staff.map(user => {
          const clubAccount = user.accountType === 'CLUB' || user.userId === data.user.id;
          const instructor = data.instructors.find(item => item.id === user.instructorId);
          return <li key={user.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(user.name)}</span>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm">{user.name}</h3>{clubAccount && <span className="badge">Club account</span>}{user.userId === data.user.id && <span className="text-[10px] text-stone-400">You</span>}</div><p className="mt-1 break-all text-xs text-stone-500">{user.email}</p><p className="mt-2 text-[11px] text-stone-500">{instructor ? `Coach profile: ${instructor.name}${instructor.active ? '' : ' (archived)'}` : user.instructorId ? 'Linked coach profile unavailable' : clubAccount ? 'This club’s workspace login' : 'Coach profile is being prepared'}</p></div>
            </div>
            {clubAccount ? <span className="flex items-center gap-1.5 text-[11px] text-[#7b867d]"><LockKeyhole size={13} />Protected club access</span> : <div className="flex gap-2 max-sm:ml-13"><Button variant="outline" size="sm" onClick={() => setEditing(user)} aria-label={`Edit coach access for ${user.name}`}><Pencil size={13} />Edit</Button><Button variant="destructive" size="sm" onClick={() => setRemoving(user)} aria-label={`Remove coach access for ${user.name}`}><Unlink size={13} />Remove</Button></div>}
          </li>;
        })}
      </ul> : <Empty title="No coaches yet" icon={ShieldCheck}>Add a registered Courtly coach account when someone joins your roster.</Empty>}
    </div>
    {editing !== undefined && <StaffEditor staffUser={editing} staff={staff} data={data} refresh={refreshAccess} onSaved={user => setStaff(previous => editing ? previous.map(item => item.id === user.id ? user : item) : [...previous, user])} onClose={() => setEditing(undefined)} />}
    {removing && <RemoveStaff staffUser={removing} refresh={refreshAccess} onRemoved={() => setStaff(previous => previous.filter(user => user.id !== removing.id))} onClose={() => setRemoving(null)} />}
  </section>;
}

function StaffEditor({ staffUser, staff, data, refresh, onSaved, onClose }: ManagementProps & { staffUser: StaffUser | null; staff: StaffUser[]; onSaved: (user: StaffUser) => void; onClose: () => void }) {
  const [instructorId, setInstructorId] = useState(staffUser?.instructorId || '');
  return <Editor title={staffUser ? 'Edit coach access' : 'Add coach access'} description={staffUser ? 'Change the roster profile linked to this coach. Their personal profile and login stay unchanged.' : 'Find an existing Courtly coach account. If they have not registered yet, ask them to create a coach account first.'} onClose={onClose} refresh={refresh} success={staffUser ? 'Coach access updated' : 'Coach added'} submitLabel={staffUser ? 'Save coach access' : 'Add coach'} onSubmit={async form => {
    const values = { instructorId: instructorId || null };
    const user = await mutate<StaffUser>(`/staff${staffUser ? `/${staffUser.id}` : ''}`, staffUser ? 'PATCH' : 'POST', staffUser ? values : {
      ...values, query: text(form, 'staff-query'),
      rescheduleNoticeHours: numeric(form, 'staff-reschedule-notice-hours'),
    });
    onSaved(user);
  }}>
    <div className="form-grid max-sm:grid-cols-1!">
      {staffUser ? <div className="field-wide flex items-center gap-3 rounded-xl border border-[#e3e9db] bg-[#f8faf6] p-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#e9f0e2] text-[#617851]"><Link2 size={17} /></span><div className="min-w-0"><p className="text-xs font-semibold text-[#344b39]">{staffUser.name}</p><p className="mt-1 break-all text-[11px] text-stone-500">{staffUser.email}</p></div></div> : <Field label="Courtly coach account" name="staff-query" type="search" required maxLength={254} autoComplete="off" wide hint="Use an exact username or email, or an unambiguous exact name." />}
      {!staffUser && <Field label="Reschedule notice (hours)" name="staff-reschedule-notice-hours" type="number" min="0" max="720" step="1" defaultValue={24} required hint="How far ahead students must request a new class time." />}
      <Field label="Coach profile (optional)" name="staff-instructor"><select id="staff-instructor" value={instructorId} onChange={event => setInstructorId(event.target.value)}><option value="">Create a coach profile automatically</option>{data.instructors.map(instructor => {
        const assigned = staff.some(user => user.instructorId === instructor.id && user.id !== staffUser?.id);
        const retained = !instructor.accountLinkAvailable && instructor.id !== staffUser?.instructorId;
        return <option key={instructor.id} value={instructor.id} disabled={assigned || retained}>{instructor.name}{assigned ? ' — login already assigned' : retained ? ' — identity retained' : !instructor.active ? ' (archived)' : ''}</option>;
      })}</select></Field>
    </div>
    <div className="space-y-2 rounded-lg border border-[#e3e9db] bg-[#f6f8f2] p-3 text-[11px] leading-relaxed text-[#64765d]"><p>Choose an existing unclaimed coach profile, or Courtly will create one from their account.</p><p>This grants access to this club only. Their password and other memberships remain private.</p></div>
  </Editor>;
}

function RemoveStaff({ staffUser, refresh, onRemoved, onClose }: { staffUser: StaffUser; refresh: () => Promise<void>; onRemoved: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mutate(`/staff/${staffUser.id}`, 'DELETE');
      onRemoved();
      toast.success('Coach access removed from this club.');
      try { await refresh(); } catch (cause) { toast.error(`Access removed, but the workspace could not refresh. ${errorMessage(cause)}`); }
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}><DialogTitle className="pr-8 text-xl font-semibold tracking-tight">Remove coach access?</DialogTitle><DialogDescription className="mt-3 text-xs leading-relaxed text-stone-500">{staffUser.name} ({staffUser.email}) will lose access to this club workspace. Their Courtly account will not be deleted, and their coach profile, lessons, and access to other clubs will stay intact.</DialogDescription>{error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}<div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={busy} onClick={onClose}>Keep access</Button><Button variant="destructive" disabled={busy} onClick={() => { void remove(); }}>{busy && <Loader2 size={15} className="animate-spin" />}{busy ? 'Removing…' : 'Remove access'}</Button></div></DialogContent></Dialog>;
}
