import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { alertAppearance, alertKind, alertPageSize, linkedIntegrityFlag, sortAlerts } from '../src/lib/alerts';

const backendSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../backend/src/${file}`, import.meta.url)), 'utf8');

describe('alertKind', () => {
  it('maps the workspace vocabulary to its own icon bucket', () => {
    expect(alertKind({ type: 'BOOKING' })).toBe('booking');
    expect(alertKind({ type: 'PAYMENT' })).toBe('payment');
    expect(alertKind({ type: 'PAYOUT' })).toBe('payout');
    expect(alertKind({ type: 'RESCHEDULE' })).toBe('reschedule');
    expect(alertKind({ type: 'CANCELLATION' })).toBe('cancellation');
    expect(alertKind({ type: 'PENDING_ACTION' })).toBe('pending');
    expect(alertKind({ type: 'INTEGRITY' })).toBe('integrity');
    expect(alertKind({ type: 'ATTENDANCE' })).toBe('attendance');
    expect(alertKind({ type: 'NOTICE' })).toBe('notice');
  });

  it('maps the student account vocabulary, which uses event names', () => {
    expect(alertKind({ type: 'BOOKING_CREATED' })).toBe('booking');
    expect(alertKind({ type: 'BOOKING_ASSIGNED' })).toBe('pending');
    expect(alertKind({ type: 'BOOKING_CANCELLED' })).toBe('cancellation');
    expect(alertKind({ type: 'RESCHEDULE_WITHDRAWN' })).toBe('reschedule');
    expect(alertKind({ type: 'PAYMENT_REVERSED' })).toBe('payment');
  });

  // Rows written before typed alerts shipped carry only wording. They still
  // have to render as something better than a generic bell.
  it('falls back to the wording when a row has no type', () => {
    expect(alertKind({ title: 'Coach payout recorded' })).toBe('payout');
    expect(alertKind({ title: 'Payment recorded' })).toBe('payment');
    expect(alertKind({ title: 'Session rescheduled' })).toBe('reschedule');
    expect(alertKind({ title: 'Session cancelled' })).toBe('cancellation');
    expect(alertKind({ title: 'Private session flagged for review' })).toBe('integrity');
    expect(alertKind({ message: 'Mark attendance for yesterday' })).toBe('attendance');
    expect(alertKind({ title: 'New booking · Marcus' })).toBe('booking');
  });

  it('prefers payout over payment when the wording mentions both', () => {
    expect(alertKind({ title: 'Coach payout reversed', message: 'payment recorded as paid' })).toBe('payout');
  });

  it('degrades an unrecognised type to a neutral bell rather than breaking', () => {
    expect(alertKind({ type: 'SOMETHING_SHIPPED_LATER' })).toBe('notice');
    expect(alertKind({})).toBe('notice');
  });

  // An alert that asks for something is worth marking as such even when its
  // wording landed in a gentler bucket.
  it('promotes an untyped actionable alert out of the neutral bucket', () => {
    expect(alertKind({ title: 'Something happened', actionNeeded: true })).toBe('pending');
    expect(alertKind({ title: 'Something happened', actionNeeded: false })).toBe('notice');
  });

  it('does not promote an alert the wording already classified', () => {
    expect(alertKind({ title: 'Session cancelled', actionNeeded: true })).toBe('cancellation');
  });

  it('gives every kind an icon, a label and a tone', () => {
    for (const type of ['BOOKING', 'PAYMENT', 'PAYOUT', 'RESCHEDULE', 'CANCELLATION',
      'PENDING_ACTION', 'INTEGRITY', 'ATTENDANCE', 'NOTICE']) {
      const appearance = alertAppearance({ type });
      expect(appearance.icon).toBeTruthy();
      expect(appearance.label.length).toBeGreaterThan(0);
      expect(appearance.tone).toMatch(/bg-\[#[0-9a-f]{6}\] text-\[#[0-9a-f]{6}\]/);
    }
  });
});

// The two alert stores are written by the backend and read by this map. A new
// alert type added on the server without a mapping here would silently render
// as a bell, so the contract is checked against the server's own source.
describe('the alert vocabulary shared with the backend', () => {
  // An unmapped type falls through to the wording, so two alerts that differ
  // only in wording agree exactly when the type itself is recognised.
  const expectMapped = (type: string) => {
    expect(alertKind({ type, title: 'Coach payout recorded' }))
      .toBe(alertKind({ type, title: 'Session cancelled' }));
  };

  it('recognises every workspace notification type the backend can write', () => {
    const source = backendSource('notifications.ts');
    const declared = source.slice(source.indexOf('notificationTypes = ['), source.indexOf('] as const'));
    const types = [...declared.matchAll(/'([A-Z_]+)'/g)].map(match => match[1]);
    expect(types.length).toBeGreaterThanOrEqual(9);
    for (const type of types) expectMapped(type);
  });

  it('recognises every student account alert type the backend can write', () => {
    const types = [...backendSource('account-notifications.ts').matchAll(/type: '([A-Z_]+)', title:/g)]
      .map(match => match[1]);
    expect(new Set(types).size).toBeGreaterThanOrEqual(12);
    for (const type of types) expectMapped(type);
  });

  it('notices a type the frontend does not know about', () => {
    expect(() => expectMapped('SHIPPED_WITHOUT_A_MAPPING')).toThrow();
  });
});

describe('sortAlerts', () => {
  const alert = (id: string, read: boolean, createdAt?: string) => ({ id, read, createdAt });

  it('puts unread first, then newest first inside each group', () => {
    const sorted = sortAlerts([
      alert('read-old', true, '2026-01-01T00:00:00.000Z'),
      alert('unread-old', false, '2026-01-02T00:00:00.000Z'),
      alert('read-new', true, '2026-03-01T00:00:00.000Z'),
      alert('unread-new', false, '2026-03-02T00:00:00.000Z'),
    ]);
    expect(sorted.map(a => a.id)).toEqual(['unread-new', 'unread-old', 'read-new', 'read-old']);
  });

  it('does not mutate the array it was given', () => {
    const input = [alert('a', true, '2026-01-01T00:00:00.000Z'), alert('b', false, '2026-01-02T00:00:00.000Z')];
    const sorted = sortAlerts(input);
    expect(input.map(a => a.id)).toEqual(['a', 'b']);
    expect(sorted.map(a => a.id)).toEqual(['b', 'a']);
  });

  it('sinks rows with a missing or unparseable timestamp below dated ones', () => {
    const sorted = sortAlerts([
      alert('undated', false),
      alert('dated', false, '2026-01-01T00:00:00.000Z'),
      alert('nonsense', false, 'not-a-date'),
    ]);
    expect(sorted[0].id).toBe('dated');
    expect(sorted.map(a => a.id).slice(1).sort()).toEqual(['nonsense', 'undated']);
  });

  it('handles an empty list', () => {
    expect(sortAlerts([])).toEqual([]);
  });
});

describe('linkedIntegrityFlag', () => {
  const flags = [{ id: 'flag-a', detail: 'First pair' }, { id: 'flag-b', detail: 'Second pair' }];

  it('returns only the flag explicitly linked by the alert', () => {
    expect(linkedIntegrityFlag({ integrityFlagId: 'flag-b' }, flags)).toEqual(flags[1]);
  });

  it('does not guess for legacy or stale alerts', () => {
    expect(linkedIntegrityFlag({}, flags)).toBeNull();
    expect(linkedIntegrityFlag({ integrityFlagId: 'missing' }, flags)).toBeNull();
  });
});

describe('integrity alert navigation', () => {
  it('does not expose integrity as a standalone workspace destination', () => {
    const shell = readFileSync(fileURLToPath(new URL('../src/components/workspace/shell-views.tsx', import.meta.url)), 'utf8');
    const views = shell.slice(shell.indexOf('export const exploreViewIds = ['), shell.indexOf('] as const;'));
    const shortcuts = shell.slice(shell.indexOf('const clubProfileShortcuts'), shell.indexOf('];', shell.indexOf('const clubProfileShortcuts')));
    const management = readFileSync(fileURLToPath(new URL('../src/components/workspace/management.tsx', import.meta.url)), 'utf8');
    expect(views).not.toContain("'integrity'");
    expect(shortcuts).not.toContain("'integrity'");
    expect(management).not.toContain("case 'integrity'");
    expect(shell).not.toContain('Open Integrity');
    expect(shell).not.toContain("onNavigate('integrity')");
  });
});

describe('alertPageSize', () => {
  it('shows a handful before offering the rest behind "Show all"', () => {
    expect(alertPageSize).toBe(5);
  });
});
