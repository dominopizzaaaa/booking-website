import type { TrainingGroup, TrainingGroupInput } from './types';

/** Mirrors the API's limits so the form can stop a save the server would refuse. */
export const trainingGroupLimits = {
  name: 80, sport: 40, level: 40, ageBand: 40, description: 600, scheduleNote: 120,
  capacityMin: 1, capacityMax: 500, members: 200,
} as const;

export type MemberDiff = { added: string[]; removed: string[]; kept: string[]; changed: boolean };

/** Membership is replaced as a set; order and repeats never count as a change. */
export function memberDiff(current: readonly string[], next: readonly string[]): MemberDiff {
  const before = new Set(current);
  const after = new Set(next);
  const added = [...after].filter(id => !before.has(id));
  const removed = [...before].filter(id => !after.has(id));
  const kept = [...after].filter(id => before.has(id));
  return { added, removed, kept, changed: added.length > 0 || removed.length > 0 };
}

export type CapacityState = { count: number; capacity: number | null; remaining: number | null; full: boolean; over: boolean; label: string };

export function capacityState(count: number, capacity: number | null | undefined): CapacityState {
  const limit = capacity && capacity > 0 ? capacity : null;
  if (limit === null) {
    return { count, capacity: null, remaining: null, full: false, over: false, label: `${count} member${count === 1 ? '' : 's'} · no limit` };
  }
  const remaining = limit - count;
  return {
    count, capacity: limit, remaining: Math.max(0, remaining), full: remaining <= 0, over: remaining < 0,
    label: `${count} of ${limit} place${limit === 1 ? '' : 's'} filled`,
  };
}

/**
 * Toggle one student. Adding is refused once the group is full; removing is
 * always allowed so a group that shrank its capacity can be brought back in.
 */
export function toggleMember(selected: readonly string[], studentId: string, capacity: number | null | undefined): string[] {
  if (selected.includes(studentId)) return selected.filter(id => id !== studentId);
  if (capacityState(selected.length, capacity).full) return [...selected];
  return [...selected, studentId];
}

type SearchableStudent = { id: string; name: string; email: string | null; phone?: string; parentName?: string };

export function filterStudents<T extends SearchableStudent>(students: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...students];
  return students.filter(student =>
    [student.name, student.email ?? '', student.phone ?? '', student.parentName ?? '']
      .some(value => value.toLocaleLowerCase().includes(needle)));
}

export type TrainingGroupFormValues = {
  name: string; sport: string; level: string; ageBand: string; description: string; scheduleNote: string;
  capacity: string; serviceId: string; locationId: string; instructorId: string;
};

export function formValuesFromGroup(group: TrainingGroup | null): TrainingGroupFormValues {
  return {
    name: group?.name ?? '', sport: group?.sport ?? '', level: group?.level ?? '', ageBand: group?.ageBand ?? '',
    description: group?.description ?? '', scheduleNote: group?.scheduleNote ?? '',
    capacity: group?.capacity ? String(group.capacity) : '',
    serviceId: group?.serviceId ?? '', locationId: group?.locationId ?? '', instructorId: group?.instructorId ?? '',
  };
}

/** Build the request body, or throw a sentence the form can show. */
export function trainingGroupInput(values: TrainingGroupFormValues, memberCount = 0): TrainingGroupInput {
  const name = values.name.trim();
  if (!name) throw new Error('Give the group a name.');
  const textFields = ['name', 'sport', 'level', 'ageBand', 'description', 'scheduleNote'] as const;
  for (const field of textFields) {
    if (values[field].trim().length > trainingGroupLimits[field]) {
      throw new Error(`Keep the ${fieldNames[field]} to ${trainingGroupLimits[field]} characters.`);
    }
  }
  let capacity: number | null = null;
  if (values.capacity.trim()) {
    capacity = Number(values.capacity);
    if (!Number.isInteger(capacity) || capacity < trainingGroupLimits.capacityMin || capacity > trainingGroupLimits.capacityMax) {
      throw new Error(`Capacity must be a whole number from ${trainingGroupLimits.capacityMin} to ${trainingGroupLimits.capacityMax}, or left blank.`);
    }
    if (capacity < memberCount) throw new Error(`This group has ${memberCount} members. Remove some or raise the capacity.`);
  }
  return {
    name, sport: values.sport.trim(), level: values.level.trim(), ageBand: values.ageBand.trim(),
    description: values.description.trim(), scheduleNote: values.scheduleNote.trim(), capacity,
    serviceId: values.serviceId || null, locationId: values.locationId || null, instructorId: values.instructorId || null,
  };
}

const fieldNames = {
  name: 'name', sport: 'sport', level: 'level', ageBand: 'age band', description: 'description', scheduleNote: 'schedule note',
} as const;

type PrefillStudent = { id: string; userId: string | null };
type PrefillService = { id: string; type: 'PRIVATE' | 'GROUP'; capacity: number };

export type SeriesPrefill = {
  serviceId?: string; locationId?: string; instructorId?: string; seriesName: string;
  studentIds: string[];
  /** Members without a Courtly account cannot be booked online. */
  skippedUnlinked: number;
  /** Members beyond the Class capacity are left for the club to place. */
  skippedOverCapacity: number;
};

/**
 * Turn a group into the booking-series dialog's starting values. Only active
 * members with a linked account can be placed, in the group's own order, and
 * never more than the chosen Class holds.
 */
export function seriesPrefill(
  group: Pick<TrainingGroup, 'name' | 'serviceId' | 'locationId' | 'instructorId' | 'members'>,
  students: readonly PrefillStudent[],
  services: readonly PrefillService[],
): SeriesPrefill {
  const linked = new Set(students.filter(student => !!student.userId).map(student => student.id));
  const memberIds = group.members.map(member => member.studentId);
  const bookable = memberIds.filter(id => linked.has(id));
  const service = group.serviceId ? services.find(candidate => candidate.id === group.serviceId) : undefined;
  const limit = !service ? bookable.length : service.type === 'GROUP' ? Math.max(0, service.capacity) : Math.min(1, bookable.length);
  const studentIds = bookable.slice(0, limit);
  return {
    serviceId: group.serviceId ?? undefined,
    locationId: group.locationId ?? undefined,
    instructorId: group.instructorId ?? undefined,
    seriesName: group.name.slice(0, 120),
    studentIds,
    skippedUnlinked: memberIds.length - bookable.length,
    skippedOverCapacity: bookable.length - studentIds.length,
  };
}
