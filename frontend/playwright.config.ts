import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'phone-390', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'phone-393', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', viewport: { width: 393, height: 852 } } },
  ],
});
