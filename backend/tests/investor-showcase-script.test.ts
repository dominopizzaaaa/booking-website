import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showcaseScript = readFileSync(
  new URL('../../scripts/populate-investor-showcase.mjs', import.meta.url),
  'utf8',
);

describe('investor showcase builder', () => {
  it('does not try to mutate the business kind after registration', () => {
    const patchStart = showcaseScript.indexOf("await club.patch('/business', {");
    const patchEnd = showcaseScript.indexOf('\n});', patchStart);
    const businessPatch = showcaseScript.slice(patchStart, patchEnd);

    expect(patchStart).toBeGreaterThanOrEqual(0);
    expect(patchEnd).toBeGreaterThan(patchStart);
    expect(businessPatch).not.toMatch(/\bkind\s*:/);
  });
});
