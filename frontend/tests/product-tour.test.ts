import { describe, expect, it } from 'vitest';
import { hasSeenProductTour, productTourIsPending, productTourSteps, productTourStorage } from '../src/lib/product-tour';

class TestStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

describe('product tour content', () => {
  it.each(['student', 'workspace-club', 'workspace-coach', 'workspace-staff', 'coach-account'] as const)(
    'gives %s a welcome, a finish, and unique stable anchors',
    kind => {
      const steps = productTourSteps({ kind, userId: 'user-1', firstName: 'Alex', businessName: 'Baseline Club' });
      expect(steps[0].anchor).toBeUndefined();
      expect(steps[0].title).toMatch(/Welcome/);
      expect(steps.at(-1)?.anchor).toBeUndefined();
      expect(steps.at(-1)?.title).toMatch(/ready/i);
      const anchors = steps.flatMap(step => step.anchor ? [step.anchor] : []);
      expect(new Set(anchors).size).toBe(anchors.length);
      expect(anchors.length).toBeGreaterThan(1);
    },
  );

  it('introduces progress and the calendar between the existing student steps', () => {
    const anchors = productTourSteps({ kind: 'student', userId: 'user-1' }).flatMap(step => step.anchor ? [step.anchor] : []);
    // Both anchors render only once a player has training or bookings, so a
    // brand-new account still gets the short tour.
    expect(anchors.indexOf('student-progress')).toBe(anchors.indexOf('student-packages') + 1);
    expect(anchors.indexOf('student-view-toggle')).toBe(anchors.indexOf('student-bookings') + 1);
  });

  it('keeps completion scoped to both the account and tour kind', () => {
    const storage = new TestStorage() as unknown as Storage;
    storage.setItem(`courtly:product-tour:student:user-1`, productTourStorage.version);
    expect(hasSeenProductTour({ kind: 'student', userId: 'user-1' }, storage)).toBe(true);
    expect(hasSeenProductTour({ kind: 'workspace-staff', userId: 'user-1' }, storage)).toBe(false);
    expect(hasSeenProductTour({ kind: 'student', userId: 'user-2' }, storage)).toBe(false);
  });

  it('recognises only the matching pending signup marker', () => {
    const storage = new TestStorage() as unknown as Storage;
    storage.setItem(productTourStorage.pendingKey, 'new-user');
    expect(productTourIsPending('new-user', storage)).toBe(true);
    expect(productTourIsPending('another-user', storage)).toBe(false);
  });

  it('keeps every configured anchor backed by a stable UI hook', async () => {
    const { readFile } = await import('node:fs/promises');
    const sources = await Promise.all([
      '../src/components/student-app.tsx',
      '../src/components/student/progress-card.tsx',
      '../src/components/workspace/app.tsx',
      '../src/components/workspace/dashboard.tsx',
      '../src/app/account/page.tsx',
    ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
    const markup = sources.join('\n');
    const kinds = ['student', 'workspace-club', 'workspace-coach', 'workspace-staff', 'coach-account'] as const;
    const anchors = new Set(kinds.flatMap(kind =>
      productTourSteps({ kind, userId: 'user-1' }).flatMap(step => step.anchor ? [step.anchor] : []),
    ));
    for (const anchor of anchors) expect(markup).toContain(`data-tour="${anchor}"`);
  });
});
