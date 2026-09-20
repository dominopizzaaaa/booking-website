import { defineConfig } from 'vitest/config';

// The browser suite (Playwright, three viewports) owns rendered behaviour.
// This runner covers the pure helpers underneath it — money and date
// formatting, avatar initials, and the shared alert vocabulary — which have
// no DOM and are far cheaper to pin down here than through a page.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
