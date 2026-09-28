'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Link2, Loader2, LockKeyhole, MailPlus, Pencil, Plus, ShieldCheck, Unlink, UserRoundCog } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, createClubStaffAccessInvitation, createStaffInvitation, loadClubStaffAccess, loadClubStaffAccessInvitations, loadStaffInvitations, mutate, revokeClubStaffAccess, revokeClubStaffAccessInvitation, revokeStaffInvitation, updateClubStaffAccess } from '@/lib/api';
import type { AccountType, ClubAccessLevel, ClubPermission, ClubStaffAccess, ClubStaffAccessInput, ClubStaffInvitation, CoachInvitation, WorkspaceResponse } from '@/lib/types';
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
  const clubAccount = props.data.accessMode === 'CLUB_ACCOUNT' || props.data.user.accountType === 'CLUB';
  const canView = clubAccount || props.data.permissions?.includes('ROSTER_VIEW') === true;
  const canManage = clubAccount || props.data.permissions?.includes('ROSTER_MANAGE') === true;
  return canView ? <ClubStaffAccess key={`${props.data.business.id}-${props.data.user.id}`} {...props} canManage={canManage} /> : null;
}

function ClubStaffAccess({ data, refresh, canManage }: ManagementProps & { canManage: boolean }) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invitations, setInvitations] = useState<CoachInvitation[]>([]);
  const [editing, setEditing] = useState<StaffUser | null | undefined>();
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [removing, setRemoving] = useState<StaffUser | null>(null);
  const loadStaff = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [users, pending] = await Promise.all([
        api<StaffUser[]>('/staff', { signal }),
        canManage ? loadStaffInvitations() : Promise.resolve({ invitations: [] }),
      ]);
      if (!signal?.aborted) { setStaff(users); setInvitations(pending.invitations); }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canManage]);
  useEffect(() => {
    const controller = new AbortController();
    void loadStaff(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [loadStaff]);
  async function refreshAccess() { await Promise.all([loadStaff(), refresh()]); }

  return <section className="mt-10 border-t border-[#e6eae3] pt-8" aria-labelledby="staff-access-heading">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div><p className="eyebrow mb-2">Club controls</p><h2 id="staff-access-heading" className="text-xl">Coach access</h2><p className="mt-2 max-w-xl text-xs leading-relaxed text-stone-500">Connect a coach who already has their own Courtly coach account.</p></div>
      {canManage && <div className="flex flex-wrap gap-2 max-sm:w-full"><Button variant="outline" onClick={() => { setInviteLink(''); setInviting(true); }} disabled={loading || !!error} className="max-sm:flex-1"><MailPlus size={15} />Invite coach</Button><Button onClick={() => setEditing(null)} disabled={loading || !!error} className="max-sm:flex-1"><Plus size={15} />Add account</Button></div>}
    </div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#e3e9db] bg-[#eff3e9] p-4">
      <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6d7d62]" />
      <div className="space-y-1.5 text-xs leading-relaxed text-[#5c7054]"><p><strong className="font-semibold">Accounts stay personal.</strong> Invite a coach by email, or add an account that already exists. You never create or handle their password.</p><p>The coach chooses when to join. Removing access only unlinks this club; their account, other affiliations, profile, and booking history remain intact.</p></div>
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
            {clubAccount ? <span className="flex items-center gap-1.5 text-[11px] text-[#7b867d]"><LockKeyhole size={13} />Protected club access</span> : canManage ? <div className="flex gap-2 max-sm:ml-13"><Button variant="outline" size="sm" onClick={() => setEditing(user)} aria-label={`Edit coach access for ${user.name}`}><Pencil size={13} />Edit</Button><Button variant="destructive" size="sm" onClick={() => setRemoving(user)} aria-label={`Remove coach access for ${user.name}`}><Unlink size={13} />Remove</Button></div> : null}
          </li>;
        })}
      </ul> : <Empty title="No coaches yet" icon={ShieldCheck}>Add a registered Courtly coach account when someone joins your roster.</Empty>}
    </div>
    {canManage && invitations.some(invitation => invitation.status === 'PENDING') && <section className="mt-5 rounded-xl border border-[#e4e9df] bg-white p-4" aria-labelledby="pending-coach-invitations"><h3 id="pending-coach-invitations" className="text-sm text-[#344b39]">Pending invitations</h3><ul className="mt-3 divide-y divide-[#edf0e8]">{invitations.filter(invitation => invitation.status === 'PENDING').map(invitation => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div><p className="text-xs font-semibold text-[#344b39]">{invitation.email}</p><p className="mt-1 text-[11px] text-stone-500">Expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div><Button type="button" variant="ghost" size="sm" onClick={() => void revokeStaffInvitation(invitation.id).then(refreshAccess).catch(cause => toast.error(errorMessage(cause)))}>Revoke</Button></li>)}</ul></section>}
    {editing !== undefined && <StaffEditor staffUser={editing} staff={staff} data={data} refresh={refreshAccess} onSaved={user => setStaff(previous => editing ? previous.map(item => item.id === user.id ? user : item) : [...previous, user])} onClose={() => setEditing(undefined)} />}
    {inviting && <InviteCoach inviteLink={inviteLink} onInviteLink={setInviteLink} refresh={refreshAccess} onClose={() => setInviting(false)} />}
    {removing && <RemoveStaff staffUser={removing} refresh={refreshAccess} onRemoved={() => setStaff(previous => previous.filter(user => user.id !== removing.id))} onClose={() => setRemoving(null)} />}
  </section>;
}

function InviteCoach({ inviteLink, onInviteLink, refresh, onClose }: { inviteLink: string; onInviteLink: (value: string) => void; refresh: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      const result = await createStaffInvitation({ email: text(form, 'invite-email'), rescheduleNoticeHours: numeric(form, 'invite-reschedule-hours') });
      onInviteLink(`${window.location.origin}${result.invitePath}`);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-lg"><DialogTitle className="text-xl font-semibold tracking-tight">Invite a coach</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">Create an email-bound link that expires in seven days. Send it using your usual email or messaging app; the coach signs up or signs in and chooses whether to join.</DialogDescription>{inviteLink ? <div className="mt-5 space-y-4"><div role="status" className="rounded-xl border border-[#d9e5d1] bg-[#f1f6ec] p-4 text-xs text-[#486344]"><p className="font-semibold">Invitation ready</p><p className="mt-2 break-all leading-relaxed">{inviteLink}</p></div><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => toast.success('Invitation link copied'))}><Copy size={14} />Copy link</Button><Button type="button" onClick={onClose}>Done</Button></div></div> : <form className="mt-5 space-y-4" onSubmit={submit}><div><label htmlFor="coach-invite-email">Coach email</label><input id="coach-invite-email" name="invite-email" type="email" autoComplete="email" required maxLength={254} placeholder="coach@example.com" disabled={busy} /></div><div><label htmlFor="coach-invite-notice">Reschedule notice (hours)</label><input id="coach-invite-notice" name="invite-reschedule-hours" type="number" min={0} max={720} step={1} defaultValue={24} required disabled={busy} /><p className="mt-1.5 text-[11px] text-stone-500">How far ahead students must request a different session time.</p></div>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}<div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}Create invite link</Button></div></form>}</DialogContent></Dialog>;
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

const accessLevels: Array<{ value: ClubAccessLevel; label: string; description: string }> = [
  { value: 'ADMINISTRATOR', label: 'Administrator', description: 'Full club access, including staff and settings.' },
  { value: 'OPERATIONS', label: 'Operations', description: 'Bookings, students, catalogue, availability, and coach roster.' },
  { value: 'FRONT_DESK', label: 'Front desk', description: 'Bookings, students, and recording incoming payments.' },
  { value: 'FINANCE', label: 'Finance', description: 'Packages, payments, payouts, reversals, and audit visibility.' },
  { value: 'SAFEGUARDING', label: 'Safeguarding', description: 'Bookings, students, integrity review, and audit visibility.' },
  { value: 'READ_ONLY', label: 'Read only', description: 'View core operations without making changes.' },
  { value: 'CUSTOM', label: 'Custom', description: 'Choose individual permissions for this person.' },
];

const permissionGroups: Array<{ label: string; permissions: Array<{ value: ClubPermission; label: string }> }> = [
  { label: 'Bookings and students', permissions: [
    { value: 'BOOKINGS_VIEW', label: 'View bookings' }, { value: 'BOOKINGS_MANAGE', label: 'Manage bookings' },
    { value: 'STUDENTS_VIEW', label: 'View students' }, { value: 'STUDENTS_MANAGE', label: 'Manage students' },
  ] },
  { label: 'Classes and coaches', permissions: [
    { value: 'CATALOG_VIEW', label: 'View catalogue' }, { value: 'CATALOG_MANAGE', label: 'Manage catalogue' },
    { value: 'AVAILABILITY_MANAGE', label: 'Manage availability' }, { value: 'ROSTER_VIEW', label: 'View coach roster' },
    { value: 'ROSTER_MANAGE', label: 'Manage coach roster' },
  ] },
  { label: 'Rentals', permissions: [
    { value: 'RENTALS_VIEW', label: 'View rental reservations' }, { value: 'RENTALS_MANAGE', label: 'Manage rentals (also requires manage catalogue)' },
  ] },
  { label: 'Money', permissions: [
    { value: 'PACKAGES_VIEW', label: 'View packages' }, { value: 'PACKAGES_MANAGE', label: 'Manage packages' },
    { value: 'PAYMENTS_VIEW', label: 'View payments' }, { value: 'PAYMENTS_RECORD', label: 'Record payments' },
    { value: 'PAYMENTS_REVERSE', label: 'Reverse payments' }, { value: 'PAYOUTS_RECORD', label: 'Record coach payouts' },
  ] },
  { label: 'Trust and administration', permissions: [
    { value: 'INTEGRITY_VIEW', label: 'View integrity cases' }, { value: 'INTEGRITY_REVIEW', label: 'Review integrity cases' },
    { value: 'SETTINGS_MANAGE', label: 'Manage settings' }, { value: 'STAFF_MANAGE', label: 'Manage staff access' },
    { value: 'AUDIT_VIEW', label: 'View audit history' },
  ] },
];

const presetPermissions: Record<Exclude<ClubAccessLevel, 'CUSTOM'>, readonly ClubPermission[]> = {
  ADMINISTRATOR: permissionGroups.flatMap(group => group.permissions.map(permission => permission.value)),
  OPERATIONS: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE', 'STUDENTS_VIEW', 'STUDENTS_MANAGE', 'CATALOG_VIEW', 'CATALOG_MANAGE', 'AVAILABILITY_MANAGE', 'ROSTER_VIEW', 'ROSTER_MANAGE', 'RENTALS_VIEW', 'RENTALS_MANAGE'],
  FRONT_DESK: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE', 'STUDENTS_VIEW', 'STUDENTS_MANAGE', 'PAYMENTS_VIEW', 'PAYMENTS_RECORD'],
  FINANCE: ['PACKAGES_VIEW', 'PACKAGES_MANAGE', 'PAYMENTS_VIEW', 'PAYMENTS_RECORD', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD', 'AUDIT_VIEW'],
  SAFEGUARDING: ['BOOKINGS_VIEW', 'STUDENTS_VIEW', 'INTEGRITY_VIEW', 'INTEGRITY_REVIEW', 'AUDIT_VIEW'],
  READ_ONLY: ['BOOKINGS_VIEW', 'STUDENTS_VIEW', 'CATALOG_VIEW', 'ROSTER_VIEW', 'PACKAGES_VIEW', 'RENTALS_VIEW'],
};

const accessLabel = (level: ClubAccessLevel) => accessLevels.find(item => item.value === level)?.label ?? level;

/** Named operational staff access is deliberately separate from the teaching roster above. */
export function NamedStaffAccess({ data }: { data: WorkspaceResponse }) {
  const [staff, setStaff] = useState<ClubStaffAccess[]>([]);
  const [invitations, setInvitations] = useState<ClubStaffInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<ClubStaffAccess | null | undefined>();
  const [removing, setRemoving] = useState<ClubStaffAccess | null>(null);
  const [inviteLink, setInviteLink] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const [accessResult, invitationResult] = await Promise.all([loadClubStaffAccess(), loadClubStaffAccessInvitations()]);
      if (!signal?.aborted) { setStaff(accessResult.staff); setInvitations(invitationResult.invitations); }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const canManageStaff = data.accessMode === 'CLUB_ACCOUNT' || data.user.accountType === 'CLUB' || data.permissions?.includes('STAFF_MANAGE') === true;
  if (!canManageStaff) return null;
  const clubAccount = data.accessMode === 'CLUB_ACCOUNT' || data.user.accountType === 'CLUB';
  const effectivePermissions = new Set(data.permissions ?? []);
  const delegablePermissions = permissionGroups.flatMap(group => group.permissions.map(permission => permission.value))
    .filter(permission => clubAccount || (permission !== 'STAFF_MANAGE' && effectivePermissions.has(permission)));
  const delegablePermissionSet = new Set(delegablePermissions);
  const availableAccessLevels = accessLevels.filter(option => clubAccount || option.value === 'CUSTOM'
    || (option.value !== 'ADMINISTRATOR' && presetPermissions[option.value].every(permission => delegablePermissionSet.has(permission))));
  const canManageTarget = (target: { userId?: string; permissions: ClubPermission[] }) => target.userId !== data.user.id
    && (clubAccount || target.permissions.every(permission => delegablePermissionSet.has(permission)));
  const activeStaff = staff.filter(person => person.active);
  const pending = invitations.filter(invitation => invitation.status === 'PENDING');

  return <section className="mt-8 border-t border-[#e6eae3] pt-8" aria-labelledby="named-staff-heading">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div><p className="eyebrow mb-2">Security</p><h2 id="named-staff-heading" className="text-xl">Staff access</h2><p className="mt-2 max-w-2xl text-xs leading-relaxed text-stone-500">Invite named team members to operate this club with only the access their job needs. This does not add them to the coach roster or change their Courtly account type.</p></div>
      <Button onClick={() => { setInviteLink(''); setEditor(null); }} disabled={loading || !!error || delegablePermissions.length === 0} title={!clubAccount && delegablePermissions.length === 0 ? 'The club account must grant you a delegable permission first' : undefined}><MailPlus size={15} />Invite staff member</Button>
    </div>
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#e3e9db] bg-[#eff3e9] p-4"><KeyRound size={18} className="mt-0.5 shrink-0 text-[#6d7d62]" /><div className="space-y-1.5 text-xs leading-relaxed text-[#5c7054]"><p><strong className="font-semibold">Least privilege by default.</strong> Choose a job preset or create a custom permission set. Presets are copied onto the person’s grant, so later product changes do not silently broaden their access.</p>{!clubAccount && <p>Because your staff access is delegated, you can grant only permissions you already hold. Administrator access and permission to manage staff can only be assigned by the club account.</p>}</div></div>
    <div className="panel overflow-hidden" aria-busy={loading}>
      {loading ? <p role="status" className="flex items-center justify-center gap-2 p-8 text-xs text-stone-500"><Loader2 size={16} className="animate-spin" />Loading staff access…</p> : error ? <div className="space-y-3 p-5"><p role="alert" className="text-xs text-red-700">{error}</p><Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button></div> : activeStaff.length ? <ul className="divide-y divide-[#edf0e8]">{activeStaff.map(person => <li key={person.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 flex-1 items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(person.name)}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm">{person.name}</h3><span className="badge">{accessLabel(person.accessLevel)}</span>{person.userId === data.user.id && <span className="text-[10px] text-stone-400">You</span>}</div><p className="mt-1 break-all text-xs text-stone-500">@{person.username} · {person.email}</p><p className="mt-2 text-[11px] text-stone-500">{person.permissions.length} permission{person.permissions.length === 1 ? '' : 's'} · {person.accountType === 'COACH' ? 'Coach account' : 'Student account'}</p></div></div>
        {canManageTarget(person) ? <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setEditor(person)}><Pencil size={13} />Edit</Button><Button variant="destructive" size="sm" onClick={() => setRemoving(person)}><Unlink size={13} />Revoke</Button></div> : <span className="flex items-center gap-1.5 text-[11px] text-[#7b867d]"><LockKeyhole size={13} />{person.userId === data.user.id ? 'Your active access' : 'Club account only'}</span>}
      </li>)}</ul> : <Empty title="No named staff yet" icon={UserRoundCog}>Invite an operations, front desk, finance, or safeguarding teammate without making them a coach.</Empty>}
    </div>
    {pending.length > 0 && <section className="mt-5 rounded-xl border border-[#e4e9df] bg-white p-4" aria-labelledby="pending-staff-invitations"><h3 id="pending-staff-invitations" className="text-sm text-[#344b39]">Pending invitations</h3><ul className="mt-3 divide-y divide-[#edf0e8]">{pending.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div><p className="text-xs font-semibold text-[#344b39]">{invitation.email}</p><p className="mt-1 text-[11px] text-stone-500">{accessLabel(invitation.accessLevel)} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div>{canManageTarget(invitation) ? <Button variant="ghost" size="sm" onClick={() => void revokeClubStaffAccessInvitation(invitation.id).then(() => { toast.success('Invitation revoked'); return load(); }).catch(cause => toast.error(errorMessage(cause)))}>Revoke</Button> : <span className="flex items-center gap-1.5 text-[11px] text-[#7b867d]"><LockKeyhole size={13} />Club account only</span>}</li>)}</ul></section>}
    {editor !== undefined && <NamedStaffEditor person={editor} inviteLink={inviteLink} onInviteLink={setInviteLink} availableAccessLevels={availableAccessLevels} delegablePermissions={delegablePermissions} delegated={!clubAccount} onClose={() => setEditor(undefined)} onSaved={() => load()} />}
    {removing && <RevokeNamedStaff person={removing} onClose={() => setRemoving(null)} onRevoked={() => load()} />}
  </section>;
}

function NamedStaffEditor({ person, inviteLink, onInviteLink, availableAccessLevels, delegablePermissions, delegated, onClose, onSaved }: { person: ClubStaffAccess | null; inviteLink: string; onInviteLink: (value: string) => void; availableAccessLevels: typeof accessLevels; delegablePermissions: ClubPermission[]; delegated: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const initialLevel = person && availableAccessLevels.some(option => option.value === person.accessLevel)
    ? person.accessLevel
    : availableAccessLevels.find(option => option.value !== 'CUSTOM')?.value ?? 'CUSTOM';
  const [level, setLevel] = useState<ClubAccessLevel>(initialLevel);
  const [permissions, setPermissions] = useState<ClubPermission[]>(() => {
    const initial = person?.permissions.filter(permission => delegablePermissions.includes(permission)) ?? [];
    return initial.includes('RENTALS_MANAGE') && delegablePermissions.includes('CATALOG_MANAGE')
      ? [...new Set<ClubPermission>([...initial, 'CATALOG_MANAGE'])]
      : initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = (permission: ClubPermission) => setPermissions(current => {
    if (current.includes(permission)) {
      if (permission === 'CATALOG_MANAGE') return current.filter(item => item !== permission && item !== 'RENTALS_MANAGE');
      return current.filter(item => item !== permission);
    }
    return permission === 'RENTALS_MANAGE'
      ? [...new Set<ClubPermission>([...current, 'CATALOG_MANAGE', permission])]
      : [...current, permission];
  });
  const values = (): ClubStaffAccessInput => level === 'CUSTOM' ? { accessLevel: level, permissions } : { accessLevel: level };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (level === 'CUSTOM' && !permissions.length) { setError('Choose at least one permission for custom access.'); return; }
    setBusy(true); setError('');
    try {
      if (person) { await updateClubStaffAccess(person.id, values()); toast.success('Staff access updated'); }
      else {
        const form = new FormData(event.currentTarget);
        const result = await createClubStaffAccessInvitation({ email: text(form, 'named-staff-email'), ...values() });
        onInviteLink(`${window.location.origin}${result.invitePath}`);
      }
      await onSaved();
      if (person) onClose();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogTitle className="text-xl font-semibold tracking-tight">{person ? `Edit ${person.name}’s access` : 'Invite a staff member'}</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">{person ? 'Changes take effect for this club only.' : 'The invitation is email-bound, expires in seven days, and never changes the recipient’s account type.'}</DialogDescription>
    {inviteLink && !person ? <div className="mt-5 space-y-4"><div role="status" className="rounded-xl border border-[#d9e5d1] bg-[#f1f6ec] p-4 text-xs text-[#486344]"><p className="font-semibold">Invitation ready</p><p className="mt-2 break-all leading-relaxed">{inviteLink}</p></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => toast.success('Invitation link copied'))}><Copy size={14} />Copy link</Button><Button onClick={onClose}>Done</Button></div></div> : <form className="mt-5 space-y-5" onSubmit={submit}>
      {!person && <div><label htmlFor="named-staff-email">Account email</label><input id="named-staff-email" name="named-staff-email" type="email" autoComplete="email" maxLength={254} required disabled={busy} placeholder="teammate@example.com" /></div>}
      {delegated && <div className="rounded-lg border border-[#e3e9db] bg-[#f6f8f2] p-3 text-[11px] leading-relaxed text-[#64765d]">You can assign only permissions already included in your staff access. Administrator access and permission to manage staff are reserved for the club account.</div>}
      <div><label htmlFor="named-staff-level">Access preset</label><select id="named-staff-level" value={level} disabled={busy} onChange={event => setLevel(event.target.value as ClubAccessLevel)}>{availableAccessLevels.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><p className="mt-1.5 text-[11px] text-stone-500">{accessLevels.find(option => option.value === level)?.description}</p></div>
      {level === 'CUSTOM' && <><p className="text-[11px] leading-relaxed text-stone-500">Managing rentals also selects catalogue management because rental settings belong to club locations.</p><fieldset className="space-y-4 rounded-xl border border-[#e3e9db] p-4"><legend className="px-1 text-xs font-semibold text-[#344b39]">Custom permissions</legend>{permissionGroups.map(group => {
        const availablePermissions = group.permissions.filter(permission => delegablePermissions.includes(permission.value));
        return availablePermissions.length > 0 && <div key={group.label}><p className="mb-2 text-[11px] font-semibold text-stone-500">{group.label}</p><div className="grid gap-2 sm:grid-cols-2">{availablePermissions.map(permission => <label key={permission.value} className="flex cursor-pointer items-center gap-2 rounded-lg bg-[#f7f8f4] px-3 py-2 text-xs text-[#405941]"><input type="checkbox" className="h-4 w-4" checked={permissions.includes(permission.value)} disabled={busy} onChange={() => toggle(permission.value)} />{permission.label}</label>)}</div></div>;
      })}</fieldset></>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}<div className="flex justify-end gap-2 border-t border-[#edf0e8] pt-4"><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}{person ? 'Save access' : 'Create invite link'}</Button></div>
    </form>}
  </DialogContent></Dialog>;
}

function RevokeNamedStaff({ person, onClose, onRevoked }: { person: ClubStaffAccess; onClose: () => void; onRevoked: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function revoke() {
    setBusy(true); setError('');
    try { await revokeClubStaffAccess(person.id); await onRevoked(); toast.success('Staff access revoked'); onClose(); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent><DialogTitle className="pr-8 text-xl font-semibold tracking-tight">Revoke staff access?</DialogTitle><DialogDescription className="mt-3 text-xs leading-relaxed text-stone-500">{person.name} will immediately lose operational access to this club. Their Courtly account, coach affiliations, and historical activity remain intact.</DialogDescription>{error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}<div className="mt-6 flex justify-end gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={busy} onClick={onClose}>Keep access</Button><Button variant="destructive" disabled={busy} onClick={() => void revoke()}>{busy && <Loader2 size={15} className="animate-spin" />}Revoke access</Button></div></DialogContent></Dialog>;
}
