import { defineConfig, devices } from '@playwright/test';
import { CHROMIUM_RESOLVER_ARGS, DOMAIN, FIREFOX_RESOLVER_PREFS } from './tests/support/deployment.ts';

// The stack is reached through its public host names. Under localhost, the
// browsers resolve them to this machine by themselves, which the suite then
// checks, as newcomers rely on it; the names of another domain lead to the
// local reverse proxy through the browsers' settings, so that no hosts-file
// change is needed on developer machines.
export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `https://portail.${DOMAIN}`,
    ignoreHTTPSErrors: true,
    // CI keeps a trace and a screenshot of every test as evidence for the stop
    // report (about 10 MB of trace per test); local runs keep failures only.
    trace: process.env.CI === undefined ? 'retain-on-failure' : 'on',
    screenshot: process.env.CI === undefined ? 'only-on-failure' : 'on',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_RESOLVER_ARGS } },
    },
    {
      // Browser-specific behaviours only (iframe origin, cookies, the WebCrypto
      // that the hybrid key wrapping relies on).
      name: 'firefox',
      grep: /@cross-browser/,
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: FIREFOX_RESOLVER_PREFS },
      },
    },
  ],
});
