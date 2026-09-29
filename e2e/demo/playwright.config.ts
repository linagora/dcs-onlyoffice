import { defineConfig, devices } from '@playwright/test';
import { CHROMIUM_RESOLVER_ARGS, DOMAIN } from '../tests/support/deployment.ts';

// The demo scenario, replayed with a video of each person's browser, on the
// standalone stack, with pnpm --filter @dcs/e2e demo. It stays out of the
// end-to-end suite, whose configuration never reaches this folder; the CI
// replays it after the suite.
export default defineConfig({
  testDir: '.',
  outputDir: '../test-results/demo',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `https://portail.${DOMAIN}`,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // As in the suite: under another domain than localhost, the stack's
        // host names lead to the local reverse proxy, with no hosts-file
        // change.
        launchOptions: { args: CHROMIUM_RESOLVER_ARGS },
      },
    },
  ],
});
