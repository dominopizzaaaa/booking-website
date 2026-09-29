import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('privacy operator queue concurrency', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'components', 'privacy', 'privacy-operator-queue.tsx'),
    'utf8',
  );

  it('invalidates stale list and event-history responses before applying state', () => {
    expect(source).toContain('const generation = ++requestGeneration.current');
    expect(source).toContain('if (generation !== requestGeneration.current) return');
    expect(source).toContain('const generation = ++eventGeneration.current');
    expect(source).toContain('generation !== eventGeneration.current || requestId !== selectedId');
  });

  it('does not offer an operator transition that impersonates subject withdrawal', () => {
    const transitionBlock = source.slice(source.indexOf('const transitions'), source.indexOf('const statusLabel'));
    expect(transitionBlock).not.toContain('CANCELLED');
    expect(source).not.toContain("CANCELLED: 'WITHDRAWN_BY_SUBJECT'");
  });
});
