'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, LockKeyhole, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, mutate } from '@/lib/api';
import type { User } from '@/lib/types';
import { initials } from '@/lib/utils';
import { Editor, Empty, Field, errorMessage, text, type ManagementProps } from './management-ui';

type StaffUser = User & { createdAt: string };
const roleLabels = { OWNER: 'Owner', ADMIN: 'Admin', COACH: 'Coach' };

export function StaffAccess(props: ManagementProps) {
  // Do not fetch staff identities, or mount management dialogs, for non-owners.
  return props.data.user.role === 'OWNER' ? <OwnerStaffAccess key={`${props.data.business.id}-${props.data.user.id}`} {...props} /> : null;
}

function OwnerStaffAccess({ data, refresh }: ManagementProps) {
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
      <div><p className="eyebrow mb-2">Owner controls</p><h2 id="staff-access-heading" className="text-xl">Staff sign-in access</h2><p className="mt-2 max-w-xl text-xs leading-relaxed text-stone-500">Give your small team a separate login. Instructor roster profiles alone do not grant access.</p></div>
      <Button onClick={() => setEditing(null)} disabled={loading || !!error} className="max-sm:w-full"><Plus size={15} />Create staff login</Button>
    </div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#e3e9db] bg-[#eff3e9] p-4">
      <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6d7d62]" />
      <div className="space-y-1.5 text-xs leading-relaxed text-[#5c7054]"><p><strong className="font-semibold">Manual setup, not an email invitation.</strong> Set an initial password and share it securely with your staff member. No email is sent.</p><p>There is no password change or reset flow yet. To replace a forgotten password, remove the login and create it again. Removing access signs them out without deleting their instructor profile or lessons.</p></div>
    </div>
    <div className="panel overflow-hidden" aria-busy={loading}>
      {loading ? <p role="status" className="flex items-center justify-center gap-2 p-8 text-xs text-stone-500"><Loader2 size={16} className="animate-spin" />Loading staff access…</p> : error ? <div className="space-y-3 p-5"><p role="alert" className="text-xs text-red-700">{error}</p><Button variant="outline" size="sm" onClick={() => { void loadStaff().catch(() => {}); }}>Try again</Button></div> : staff.length ? <ul className="divide-y divide-[#edf0e8]">
        {staff.map(user => {
          const owner = user.role === 'OWNER' || user.id === data.user.id;
          const instructor = data.instructors.find(item => item.id === user.instructorId);
          return <li key={user.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(user.name)}</span>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm">{user.name}</h3><span className="badge">{roleLabels[user.role]}</span>{user.id === data.user.id && <span className="text-[10px] text-stone-400">You</span>}</div><p className="mt-1 break-all text-xs text-stone-500">{user.email}</p><p className="mt-2 text-[11px] text-stone-500">{instructor ? `Instructor: ${instructor.name}${instructor.active ? '' : ' (archived)'}` : user.instructorId ? 'Linked instructor unavailable' : user.role === 'COACH' ? 'No instructor linked — edit access to assign one' : 'No instructor profile linked'}</p></div>
            </div>
            {owner ? <span className="flex items-center gap-1.5 text-[11px] text-[#7b867d]"><LockKeyhole size={13} />Protected owner access</span> : <div className="flex gap-2 max-sm:ml-13"><Button variant="outline" size="sm" onClick={() => setEditing(user)} aria-label={`Edit access for ${user.name}`}><Pencil size={13} />Edit</Button><Button variant="destructive" size="sm" onClick={() => setRemoving(user)} aria-label={`Remove access for ${user.name}`}><Trash2 size={13} />Remove</Button></div>}
          </li>;
        })}
      </ul> : <Empty title="Just you for now" icon={ShieldCheck}>Create a login when someone on your team needs access.</Empty>}
    </div>
    {editing !== undefined && <StaffEditor staffUser={editing} staff={staff} data={data} refresh={refreshAccess} onSaved={user => setStaff(previous => editing ? previous.map(item => item.id === user.id ? user : item) : [...previous, user])} onClose={() => setEditing(undefined)} />}
    {removing && <RemoveStaff staffUser={removing} refresh={refreshAccess} onRemoved={() => setStaff(previous => previous.filter(user => user.id !== removing.id))} onClose={() => setRemoving(null)} />}
  </section>;
}

function StaffEditor({ staffUser, staff, data, refresh, onSaved, onClose }: ManagementProps & { staffUser: StaffUser | null; staff: StaffUser[]; onSaved: (user: StaffUser) => void; onClose: () => void }) {
  const [role, setRole] = useState<'ADMIN' | 'COACH'>(staffUser?.role === 'ADMIN' ? 'ADMIN' : 'COACH');
  const [instructorId, setInstructorId] = useState(staffUser?.instructorId || '');
  return <Editor title={staffUser ? 'Edit staff access' : 'Create a staff login'} description={staffUser ? 'Update their name, role, or instructor link. Login email and password cannot be changed here.' : 'Create a login directly. Share the login email and initial password securely; Courtly does not send an invitation.'} onClose={onClose} refresh={refresh} success={staffUser ? 'Staff access updated' : 'Staff login created. Share the initial password securely.'} submitLabel={staffUser ? 'Save staff access' : 'Create staff login'} onSubmit={async form => {
    if (role === 'COACH' && !instructorId) throw new Error('Choose an instructor for this coach login.');
    const values = { name: text(form, 'staff-name'), role, instructorId: instructorId || null };
    const user = await mutate<StaffUser>(`/staff${staffUser ? `/${staffUser.id}` : ''}`, staffUser ? 'PATCH' : 'POST', staffUser ? values : { ...values, email: text(form, 'staff-email'), password: String(form.get('staff-password') || '') });
    onSaved(user);
  }}>
    <div className="form-grid max-sm:grid-cols-1!">
      <Field label="Full name" name="staff-name" defaultValue={staffUser?.name} required maxLength={120} autoComplete="name" wide />
      <Field label="Login email" name="staff-email" type="email" defaultValue={staffUser?.email} required maxLength={254} autoComplete="off" disabled={!!staffUser} wide hint={staffUser ? 'To use a different email, remove this login and create a new one.' : 'Use a separate email for each staff member.'} />
      {!staffUser && <Field label="Initial password" name="staff-password" type="password" required minLength={12} maxLength={72} autoComplete="new-password" wide hint="At least 12 characters, up to 72 UTF-8 bytes. Save it securely before submitting: it cannot be viewed or reset later." />}
      <Field label="Access role" name="staff-role"><select id="staff-role" value={role} onChange={event => setRole(event.target.value as 'ADMIN' | 'COACH')} required><option value="COACH">Coach</option><option value="ADMIN">Admin</option></select></Field>
      <Field label={role === 'COACH' ? 'Instructor (required)' : 'Instructor (optional)'} name="staff-instructor"><select id="staff-instructor" value={instructorId} onChange={event => setInstructorId(event.target.value)} required={role === 'COACH'}><option value="">{role === 'COACH' ? 'Choose an instructor' : 'No instructor link'}</option>{data.instructors.map(instructor => {
        const assigned = staff.some(user => user.instructorId === instructor.id && user.id !== staffUser?.id);
        return <option key={instructor.id} value={instructor.id} disabled={assigned}>{instructor.name}{assigned ? ' — login already assigned' : !instructor.active ? ' (archived)' : ''}</option>;
      })}</select></Field>
    </div>
    <div className="space-y-2 rounded-lg border border-[#e3e9db] bg-[#f6f8f2] p-3 text-[11px] leading-relaxed text-[#64765d]"><p>{role === 'ADMIN' ? 'Admins manage day-to-day workspace operations. Only the owner can manage staff sign-in access.' : 'Coaches access their linked instructor’s schedule. Each instructor can be linked to only one login.'}</p>{!data.instructors.length && <p>Add an instructor in the roster above before creating a coach login.</p>}<p>No email invitation or password reset flow is available yet.</p></div>
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
      toast.success('Staff access removed. Their active sessions have ended.');
      try { await refresh(); } catch (cause) { toast.error(`Access removed, but the workspace could not refresh. ${errorMessage(cause)}`); }
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}><DialogTitle className="pr-8 text-xl font-semibold tracking-tight">Remove staff access?</DialogTitle><DialogDescription className="mt-3 text-xs leading-relaxed text-stone-500">{staffUser.name} ({staffUser.email}) will lose sign-in access immediately and their active sessions will end. Their instructor profile and existing lessons will stay. To restore access later, create a new login.</DialogDescription>{error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}<div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={busy} onClick={onClose}>Keep access</Button><Button variant="destructive" disabled={busy} onClick={() => { void remove(); }}>{busy && <Loader2 size={15} className="animate-spin" />}{busy ? 'Removing…' : 'Remove access'}</Button></div></DialogContent></Dialog>;
}
