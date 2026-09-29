import { defineConfig, devices } from '@playwright/test';
import { DOMAIN } from '../tests/support/deployment.ts';

// The README's screenshots (docs/screenshots), taken on the standalone stack
// with pnpm --filter @dcs/e2e captures. They stay out of the end-to-end suite,
// whose configuration never reaches this folder.
export default defineConfig({
  testDir: '.',
  outputDir: '../test-results/captures',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `https://portail.${DOMAIN}`,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Pages of 1440 × 900, taken at double density to stay sharp in the
        // README.
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        // As in the suite: the stack's host names lead to the local reverse
        // proxy, with no hosts-file change.
        launchOptions: { args: [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`] },
      },
    },
  ],
});
