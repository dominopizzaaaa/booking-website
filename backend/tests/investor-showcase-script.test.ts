import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showcaseScript = readFileSync(
  new URL('../../scripts/populate-investor-showcase.mjs', import.meta.url),
  'utf8',
);

describe('investor showcase builder', () => {
  it('registers every deterministic persona with a distinct valid username', () => {
    const usernames = [...showcaseScript.matchAll(/username: '(investor_demo_[a-z]+)'/g)]
      .map(([, username]) => username);

    expect(usernames).toEqual([
      'investor_demo_club',
      'investor_demo_avery',
      'investor_demo_maya',
      'investor_demo_daniel',
      'investor_demo_jamie',
      'investor_demo_ethan',
      'investor_demo_priya',
      'investor_demo_noah',
      'investor_demo_sofia',
      'investor_demo_grace',
      'investor_demo_lucas',
      'investor_demo_amelia',
    ]);
    expect(new Set(usernames).size).toBe(usernames.length);
    expect(usernames.every(username => /^[a-z0-9_]{3,30}$/.test(username))).toBe(true);

    const registrationStart = showcaseScript.indexOf("clients[key].post('/auth/register', {");
    const registrationEnd = showcaseScript.indexOf("if (key === 'club') clubWasCreated", registrationStart);
    expect(registrationStart).toBeGreaterThanOrEqual(0);
    expect(registrationEnd).toBeGreaterThan(registrationStart);
    const registrationPayload = showcaseScript.slice(registrationStart, registrationEnd);
    expect(registrationPayload).toContain('username: person.username');
  });

  it('does not try to mutate the business kind after registration', () => {
    const patchStart = showcaseScript.indexOf("await club.patch('/business', {");
    const patchEnd = showcaseScript.indexOf('\n});', patchStart);
    const businessPatch = showcaseScript.slice(patchStart, patchEnd);

    expect(patchStart).toBeGreaterThanOrEqual(0);
    expect(patchEnd).toBeGreaterThan(patchStart);
    expect(businessPatch).not.toMatch(/\bkind\s*:/);
  });
});
