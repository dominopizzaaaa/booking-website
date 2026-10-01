import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Railway deployment health check', () => {
  it('uses the database-independent liveness endpoint', () => {
    const railwayConfig = readFileSync(new URL('../railway.toml', import.meta.url), 'utf8');

    expect(railwayConfig).toMatch(/^healthcheckPath = "\/api\/live"$/mu);
    expect(railwayConfig).not.toMatch(/^healthcheckPath = "\/api\/health"$/mu);
  });
});
