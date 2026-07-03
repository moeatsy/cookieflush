import { defineConfig } from '@playwright/test';

// E2E for the CookieFlush MV3 extension. Extension state (cookies, storage) is
// global to the browser profile, so tests run serially in one worker.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
});
