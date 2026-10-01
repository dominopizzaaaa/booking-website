import { describe, expect, it } from 'vitest';
import type { TrainingGroup } from '../src/lib/types';
import {
  capacityState, filterStudents, formValuesFromGroup, memberDiff, seriesPrefill, toggleMember, trainingGroupInput,
} from '../src/lib/training-groups';

const member = (studentId: string, name = studentId) => ({ studentId, name, initials: name.slice(0, 2).toUpperCase(), joinedAt: '2026-09-01T00:00:00.000Z' });
const group = (overrides: Partial<TrainingGroup> = {}): TrainingGroup => ({
  id: 'group-1', name: 'Saturday juniors', sport: 'Tennis', level: 'Beginner', ageBand: '8–10', description: '', scheduleNote: '',
  capacity: 4, serviceId: 'svc-group', locationId: 'loc-1', instructorId: 'coach-1', active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  members: [member('s1'), member('s2'), member('s3')],
  ...overrides,
});

describe('memberDiff', () => {
  it('reports additions and removals as sets', () => {
    expect(memberDiff(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual({ added: ['d'], removed: ['b'], kept: ['c', 'a'], changed: true });
  });

  it('ignores order and repeats', () => {
    expect(memberDiff(['a', 'b'], ['b', 'a', 'a']).changed).toBe(false);
    expect(memberDiff([], []).changed).toBe(false);
  });
});

describe('capacity', () => {
  it('describes groups with and without a limit', () => {
    expect(capacityState(3, 4)).toMatchObject({ remaining: 1, full: false, over: false, label: '3 of 4 places filled' });
    expect(capacityState(1, null)).toMatchObject({ capacity: null, remaining: null, full: false, label: '1 member · no limit' });
    expect(capacityState(0, 0).capacity).toBeNull();
  });

  it('flags full and over-capacity groups', () => {
    expect(capacityState(4, 4)).toMatchObject({ full: true, over: false, remaining: 0 });
    expect(capacityState(5, 4)).toMatchObject({ full: true, over: true, remaining: 0 });
  });

  it('refuses to add past capacity but always allows removal', () => {
    expect(toggleMember(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(toggleMember(['a', 'b'], 'c', 3)).toEqual(['a', 'b', 'c']);
    expect(toggleMember(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'c']);
    expect(toggleMember([], 'a', null)).toEqual(['a']);
  });
});

describe('filterStudents', () => {
  const students = [
    { id: '1', name: 'Ava Tan', email: 'ava@example.test', phone: '9123', parentName: 'Mei Tan' },
    { id: '2', name: 'Ben Lim', email: null, phone: '', parentName: '' },
  ];
  it('matches name, email, phone and parent, case-insensitively', () => {
    expect(filterStudents(students, 'AVA').map(student => student.id)).toEqual(['1']);
    expect(filterStudents(students, 'mei').map(student => student.id)).toEqual(['1']);
    expect(filterStudents(students, 'lim').map(student => student.id)).toEqual(['2']);
    expect(filterStudents(students, '  ').length).toBe(2);
  });
});

describe('trainingGroupInput', () => {
  it('trims fields and turns blank defaults into null', () => {
    const values = { ...formValuesFromGroup(null), name: '  Squad  ', capacity: '', serviceId: '' };
    expect(trainingGroupInput(values)).toEqual({
      name: 'Squad', sport: '', level: '', ageBand: '', description: '', scheduleNote: '', capacity: null,
      serviceId: null, locationId: null, instructorId: null,
    });
  });

  it('round-trips an existing group', () => {
    expect(trainingGroupInput(formValuesFromGroup(group()), 3)).toMatchObject({ name: 'Saturday juniors', capacity: 4, serviceId: 'svc-group' });
  });

  it('explains invalid input in a sentence', () => {
    expect(() => trainingGroupInput({ ...formValuesFromGroup(null), name: ' ' })).toThrow('Give the group a name.');
    expect(() => trainingGroupInput({ ...formValuesFromGroup(null), name: 'x'.repeat(81) })).toThrow('Keep the name to 80 characters.');
    expect(() => trainingGroupInput({ ...formValuesFromGroup(null), name: 'Squad', capacity: '2.5' })).toThrow(/whole number/);
    expect(() => trainingGroupInput({ ...formValuesFromGroup(null), name: 'Squad', capacity: '501' })).toThrow(/whole number/);
    expect(() => trainingGroupInput({ ...formValuesFromGroup(null), name: 'Squad', capacity: '2' }, 3)).toThrow('This group has 3 members. Remove some or raise the capacity.');
  });
});

describe('seriesPrefill', () => {
  const students = [{ id: 's1', userId: 'u1' }, { id: 's2', userId: null }, { id: 's3', userId: 'u3' }, { id: 's4', userId: 'u4' }];
  const services = [
    { id: 'svc-group', type: 'GROUP' as const, capacity: 2 },
    { id: 'svc-private', type: 'PRIVATE' as const, capacity: 1 },
  ];

  it('keeps linked members in order up to the Class capacity', () => {
    const prefill = seriesPrefill(group({ members: [member('s1'), member('s2'), member('s3'), member('s4')] }), students, services);
    expect(prefill).toEqual({
      serviceId: 'svc-group', locationId: 'loc-1', instructorId: 'coach-1', seriesName: 'Saturday juniors',
      studentIds: ['s1', 's3'], skippedUnlinked: 1, skippedOverCapacity: 1,
    });
  });

  it('places one member for a private Class', () => {
    expect(seriesPrefill(group({ serviceId: 'svc-private' }), students, services).studentIds).toEqual(['s1']);
  });

  it('leaves the Class choice open when the group has no default', () => {
    const prefill = seriesPrefill(group({ serviceId: null, locationId: null, instructorId: null }), students, services);
    expect(prefill).toMatchObject({ serviceId: undefined, locationId: undefined, instructorId: undefined, studentIds: ['s1', 's3'], skippedOverCapacity: 0 });
  });
});
