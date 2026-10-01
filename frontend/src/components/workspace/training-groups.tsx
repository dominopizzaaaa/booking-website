'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CalendarPlus, Loader2, Pencil, Plus, Search, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { archiveTrainingGroup, createTrainingGroup, loadTrainingGroups, setTrainingGroupMembers, updateTrainingGroup } from '@/lib/api';
import type { ManagerWorkspace, TrainingGroup } from '@/lib/types';
import {
  capacityState, filterStudents, formValuesFromGroup, memberDiff, seriesPrefill, toggleMember, trainingGroupInput,
  trainingGroupLimits, type TrainingGroupFormValues,
} from '@/lib/training-groups';
import { initials } from '@/lib/utils';
import { NewBookingDialog, type BookingDialogInitial } from './booking-dialogs';
import { ConfirmActionDialog, Editor, Empty, errorMessage } from './management-ui';

type TrainingGroupsProps = {
  data: ManagerWorkspace;
  refresh: () => Promise<void>;
  canManage: boolean;
  /** Scheduling creates bookings, so it needs booking permission as well. */
  canSchedule: boolean;
};

/**
 * Club-local training groups.
 *
 * A group is a standing list of the club's own students with sensible
 * defaults. It never books anything by itself: "Schedule series" opens the
 * ordinary series dialog already filled in, so every booking still goes
 * through the same checks as one made by hand.
 */
export function TrainingGroups({ data, refresh, canManage, canSchedule }: TrainingGroupsProps) {
  const [groups, setGroups] = useState<TrainingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TrainingGroup | null | undefined>();
  const [archiving, setArchiving] = useState<TrainingGroup | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [scheduling, setScheduling] = useState<BookingDialogInitial | null>(null);

  const reload = useCallback(async () => {
    setError('');
    try {
      const result = await loadTrainingGroups();
      setGroups(result.groups.filter(group => group.active));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function archive() {
    if (!archiving) return;
    setArchiveBusy(true);
    try {
      await archiveTrainingGroup(archiving.id);
      toast.success(`${archiving.name} archived`);
      setArchiving(null);
      await reload();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setArchiveBusy(false);
    }
  }

  function schedule(group: TrainingGroup) {
    const prefill = seriesPrefill(group, data.students, data.services);
    const notes = [`Scheduling ${group.name}: ${prefill.studentIds.length} member${prefill.studentIds.length === 1 ? '' : 's'} added to the roster.`];
    if (prefill.skippedUnlinked) notes.push(`${prefill.skippedUnlinked} without a Courtly account cannot be booked online.`);
    if (prefill.skippedOverCapacity) notes.push(`${prefill.skippedOverCapacity} did not fit the Class capacity.`);
    if (!group.serviceId) notes.push('Choose a group Class to place the members.');
    setScheduling({
      mode: 'SERIES', serviceId: prefill.serviceId, locationId: prefill.locationId, instructorId: prefill.instructorId,
      studentIds: prefill.studentIds, seriesName: prefill.seriesName, notice: notes.join(' '),
    });
  }

  const serviceName = (id: string | null) => id ? data.services.find(service => service.id === id)?.name ?? 'Unavailable Class' : null;
  const locationName = (id: string | null) => id ? data.locations.find(location => location.id === id)?.name ?? 'Unavailable venue' : null;
  const coachName = (id: string | null) => id ? data.instructors.find(instructor => instructor.id === id)?.name ?? 'Unavailable coach' : null;

  return <section aria-labelledby="training-groups-heading">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id="training-groups-heading" className="text-base text-[#294735]">Training groups</h2>
        <p className="!mt-1 max-w-2xl text-xs leading-relaxed text-[#59675c]">Standing squads of your own students, with a default Class, venue and lead coach. Groups are private to the club.</p>
      </div>
      {canManage && <Button onClick={() => setEditing(null)} className="max-sm:w-full"><Plus size={15} aria-hidden="true" />New group</Button>}
    </div>
    <div aria-live="polite" aria-busy={loading}>
      {loading ? <div className="panel flex min-h-40 items-center justify-center gap-2 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Loading training groups…</div>
        : error ? <div className="panel flex min-h-40 flex-col items-center justify-center gap-3 p-5 text-center"><p role="alert" className="text-xs text-red-700">{error}</p><Button size="sm" variant="outline" onClick={() => { setLoading(true); void reload(); }}>Try again</Button></div>
          : !groups.length ? <div className="panel"><Empty title="No training groups yet" icon={UsersRound} action={canManage ? <Button size="sm" onClick={() => setEditing(null)}><Plus size={14} aria-hidden="true" />Create a group</Button> : undefined}>{canManage ? 'Group regulars into a squad, then schedule a whole term for them in one step.' : 'Groups the club creates will appear here.'}</Empty></div>
            : <ul className="cards-grid" aria-label="Training groups">{groups.map(group => {
              const capacity = capacityState(group.members.length, group.capacity);
              const defaults = [serviceName(group.serviceId), locationName(group.locationId), coachName(group.instructorId)].filter(Boolean) as string[];
              const tags = [group.sport, group.level, group.ageBand].filter(Boolean);
              return <li key={group.id} className="panel flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 text-base text-[#294735]">{group.name}</h3>
                  <span className={`badge shrink-0 ${capacity.full ? 'pending' : ''}`}>{capacity.label}</span>
                </div>
                {tags.length > 0 && <p className="!mt-2 flex flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className="badge bg-stone-100! text-stone-600!">{tag}</span>)}</p>}
                {group.description && <p className="!mt-3 text-xs leading-relaxed text-[#59675c]">{group.description}</p>}
                <dl className="mt-3 space-y-1 text-[11px] text-[#59675c]">
                  {group.scheduleNote && <div><dt className="inline font-semibold text-[#405941]">When: </dt><dd className="inline">{group.scheduleNote}</dd></div>}
                  <div><dt className="inline font-semibold text-[#405941]">Defaults: </dt><dd className="inline">{defaults.length ? defaults.join(' · ') : 'None set'}</dd></div>
                </dl>
                <div className="mt-4">
                  {group.members.length ? <ul className="flex flex-wrap gap-1.5" aria-label={`${group.name} members`}>
                    {group.members.slice(0, 12).map(member => <li key={member.studentId} className="inline-flex items-center gap-1.5 rounded-full bg-[#f1f5ec] py-1 pl-1 pr-2.5 text-[11px] text-[#344b39]"><span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-[#dce6d1] text-[9px] font-semibold">{member.initials || initials(member.name)}</span>{member.name}</li>)}
                    {group.members.length > 12 && <li className="rounded-full bg-[#f1f5ec] px-2.5 py-1 text-[11px] text-[#344b39]">and {group.members.length - 12} more</li>}
                  </ul> : <p className="text-[11px] text-[#59675c]">No members yet.</p>}
                </div>
                {(canManage || canSchedule) && <div className="mt-auto flex flex-wrap gap-2 pt-5">
                  {canSchedule && <Button size="sm" onClick={() => schedule(group)} disabled={!group.members.length}><CalendarPlus size={13} aria-hidden="true" />Schedule series<span className="sr-only"> for {group.name}</span></Button>}
                  {canManage && <Button size="sm" variant="outline" onClick={() => setEditing(group)}><Pencil size={13} aria-hidden="true" />Edit<span className="sr-only"> {group.name}</span></Button>}
                  {canManage && <Button size="sm" variant="ghost" onClick={() => setArchiving(group)}><Archive size={13} aria-hidden="true" />Archive<span className="sr-only"> {group.name}</span></Button>}
                </div>}
              </li>;
            })}</ul>}
    </div>
    {canManage && editing !== undefined && <TrainingGroupEditor group={editing} data={data} onSaved={reload} onClose={() => setEditing(undefined)} />}
    {canManage && <ConfirmActionDialog open={!!archiving} title="Archive this training group?" description={archiving ? `${archiving.name} will be hidden from the club's groups. Students and their bookings are not changed.` : ''} confirmLabel="Archive group" destructive busy={archiveBusy} onClose={() => setArchiving(null)} onConfirm={() => void archive()} />}
    {canSchedule && scheduling && <NewBookingDialog data={data} open initial={scheduling} onClose={() => setScheduling(null)} refresh={refresh} />}
  </section>;
}

function TrainingGroupEditor({ group, data, onSaved, onClose }: { group: TrainingGroup | null; data: ManagerWorkspace; onSaved: () => Promise<void>; onClose: () => void }) {
  const [values, setValues] = useState<TrainingGroupFormValues>(() => formValuesFromGroup(group));
  const originalMembers = useMemo(() => group?.members.map(member => member.studentId) ?? [], [group]);
  const [members, setMembers] = useState<string[]>(originalMembers);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Removing a chip removes the focused button, so hand focus to the search.
  const removeMember = (id: string) => { setMembers(current => current.filter(item => item !== id)); searchRef.current?.focus(); };
  const capacity = values.capacity.trim() ? Number(values.capacity) : null;
  const capacityInfo = capacityState(members.length, Number.isFinite(capacity) ? capacity : null);
  const studentsById = new Map(data.students.map(student => [student.id, student]));
  const matches = filterStudents(data.students, query).sort((a, b) => a.name.localeCompare(b.name));
  const service = data.services.find(item => item.id === values.serviceId);
  const activeLocations = data.locations.filter(location => location.active);
  const venueOptions = service ? activeLocations.filter(location => service.locations.some(mapping => mapping.locationId === location.id)) : activeLocations;
  const mapping = service?.locations.find(item => item.locationId === values.locationId);
  const coachOptions = data.instructors.filter(instructor => instructor.active && (!mapping || mapping.instructorIds.includes(instructor.id)));
  const set = (change: Partial<TrainingGroupFormValues>) => setValues(current => ({ ...current, ...change }));

  function chooseService(serviceId: string) {
    const next = data.services.find(item => item.id === serviceId);
    const locationOk = !next || next.locations.some(item => item.locationId === values.locationId);
    const nextLocation = locationOk ? values.locationId : '';
    const nextMapping = next?.locations.find(item => item.locationId === nextLocation);
    const coachOk = !nextMapping || nextMapping.instructorIds.includes(values.instructorId);
    set({ serviceId, locationId: nextLocation, instructorId: coachOk ? values.instructorId : '' });
  }
  function chooseLocation(locationId: string) {
    const nextMapping = service?.locations.find(item => item.locationId === locationId);
    const coachOk = !nextMapping || nextMapping.instructorIds.includes(values.instructorId);
    set({ locationId, instructorId: coachOk ? values.instructorId : '' });
  }

  async function save() {
    const input = trainingGroupInput(values, members.length);
    const diff = memberDiff(originalMembers, members);
    if (!group) {
      const created = await createTrainingGroup(input);
      if (members.length) await setTrainingGroupMembers(created.id, members);
    } else {
      // Order the two writes so capacity is never below the member count in
      // between: shrink the list first, or raise capacity first.
      const membersFirst = diff.changed && members.length <= (group.capacity ?? Number.POSITIVE_INFINITY);
      if (membersFirst) await setTrainingGroupMembers(group.id, members);
      await updateTrainingGroup(group.id, input);
      if (diff.changed && !membersFirst) await setTrainingGroupMembers(group.id, members);
    }
  }

  return <Editor
    title={group ? `Edit ${group.name}` : 'New training group'}
    description="Members are students already connected to the club. Defaults prefill the series dialog when you schedule the group."
    wide
    onClose={onClose}
    refresh={onSaved}
    success={group ? 'Training group saved' : 'Training group created'}
    submitLabel={group ? 'Save group' : 'Create group'}
    onSubmit={save}
  >
    <div className="form-grid max-sm:grid-cols-1!">
      <div className="field-wide"><label htmlFor="group-name">Group name<span className="ml-1 text-[#88957e]" aria-hidden="true">*</span></label><input id="group-name" value={values.name} maxLength={trainingGroupLimits.name} required onChange={event => set({ name: event.target.value })} placeholder="Saturday junior squad" /></div>
      <div><label htmlFor="group-sport">Sport</label><input id="group-sport" value={values.sport} maxLength={trainingGroupLimits.sport} onChange={event => set({ sport: event.target.value })} placeholder="Tennis" /></div>
      <div><label htmlFor="group-level">Level</label><input id="group-level" value={values.level} maxLength={trainingGroupLimits.level} onChange={event => set({ level: event.target.value })} placeholder="Intermediate" /></div>
      <div><label htmlFor="group-age-band">Age band</label><input id="group-age-band" value={values.ageBand} maxLength={trainingGroupLimits.ageBand} onChange={event => set({ ageBand: event.target.value })} placeholder="10–12" /></div>
      <div><label htmlFor="group-capacity">Capacity</label><input id="group-capacity" type="number" inputMode="numeric" min={trainingGroupLimits.capacityMin} max={trainingGroupLimits.capacityMax} step={1} value={values.capacity} onChange={event => set({ capacity: event.target.value })} aria-describedby="group-capacity-hint" /><p id="group-capacity-hint" className="!mt-1.5 text-[11px] text-[#59675c]">Leave blank for no limit.</p></div>
      <div className="field-wide"><label htmlFor="group-schedule-note">When the group trains</label><input id="group-schedule-note" value={values.scheduleNote} maxLength={trainingGroupLimits.scheduleNote} onChange={event => set({ scheduleNote: event.target.value })} placeholder="Saturdays, 9–10:30 am" /></div>
      <div className="field-wide"><label htmlFor="group-description">Description</label><textarea id="group-description" rows={2} value={values.description} maxLength={trainingGroupLimits.description} onChange={event => set({ description: event.target.value })} placeholder="Who the group is for and what it works on" /></div>
    </div>
    <fieldset className="rounded-xl border border-[#e3e8df] p-4">
      <legend className="px-1 text-xs font-semibold text-[#344b39]">Defaults for scheduling</legend>
      <div className="form-grid max-sm:grid-cols-1!">
        <div className="field-wide"><label htmlFor="group-service">Class</label><select id="group-service" value={values.serviceId} onChange={event => chooseService(event.target.value)}><option value="">No default</option>{data.services.filter(item => item.active || item.id === values.serviceId).map(item => <option key={item.id} value={item.id}>{item.name}{item.type === 'GROUP' ? ` · group of ${item.capacity}` : ' · private'}</option>)}</select></div>
        <div><label htmlFor="group-location">Venue</label><select id="group-location" value={values.locationId} onChange={event => chooseLocation(event.target.value)}><option value="">No default</option>{venueOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div><label htmlFor="group-instructor">Lead coach</label><select id="group-instructor" value={values.instructorId} onChange={event => set({ instructorId: event.target.value })}><option value="">No default</option>{coachOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      </div>
      {service && service.type !== 'GROUP' && <p className="!mt-3 text-[11px] leading-relaxed text-[#70582e]">This is a private Class, so a scheduled series places one member at a time.</p>}
    </fieldset>
    <fieldset className="rounded-xl border border-[#e3e8df] p-4">
      <legend className="px-1 text-xs font-semibold text-[#344b39]">Members</legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs font-medium ${capacityInfo.over ? 'text-red-700' : 'text-[#405941]'}`} aria-live="polite">{capacityInfo.label}{capacityInfo.over ? ' · over capacity' : ''}</p>
        {members.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => { setMembers([]); searchRef.current?.focus(); }}>Clear all</Button>}
      </div>
      {members.length > 0 && <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected members">{members.map(id => {
        const student = studentsById.get(id);
        const name = student?.name ?? group?.members.find(member => member.studentId === id)?.name ?? 'Former student';
        return <li key={id}><button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-full bg-[#e8efe0] px-2.5 text-[11px] font-medium text-[#344b39] hover:bg-[#dce6d1]" onClick={() => removeMember(id)} aria-label={`Remove ${name}`}>{name}<span aria-hidden="true">×</span></button></li>;
      })}</ul>}
      <div className="relative mt-3"><Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 text-[#59675c]" /><input ref={searchRef} type="search" aria-label="Search students to add" placeholder="Search name, email, or phone…" value={query} onChange={event => setQuery(event.target.value)} className="pl-9!" /></div>
      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-[#edf0e8]">
        {matches.length ? <ul>{matches.map(student => {
          const selected = members.includes(student.id);
          const blocked = !selected && capacityInfo.full;
          return <li key={student.id} className="border-b border-[#f0f2ec] last:border-b-0">
            <label className={`mb-0 flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-xs ${blocked ? 'cursor-not-allowed opacity-60' : 'hover:bg-[#f8faf6]'}`}>
              <input type="checkbox" checked={selected} disabled={blocked} onChange={() => setMembers(current => toggleMember(current, student.id, Number.isFinite(capacity) ? capacity : null))} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium text-[#344b39]">{student.name}</span><span className="block truncate text-[11px] font-normal text-[#59675c]">{student.userId ? student.email ?? 'No direct email' : 'No Courtly account · cannot be booked online'}</span></span>
            </label>
          </li>;
        })}</ul> : <p className="p-3 text-xs text-[#59675c]">{query ? 'No students match that search.' : 'Connect students to the club first.'}</p>}
      </div>
      {capacityInfo.full && <p className="!mt-2 text-[11px] text-[#70582e]">The group is full. Raise the capacity to add more members.</p>}
    </fieldset>
  </Editor>;
}
