import { defineConfig, devices } from '@playwright/test';
import { DOMAIN } from './tests/support/deployment.ts';

// The stack is reached through its public host names; map them to the local
// reverse proxy so that no hosts-file change is needed on developer machines.
const hostResolverRules = `--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`;
const localDomains = ['portail', 'docs', 'idp', 'tdf'].map((host) => `${host}.${DOMAIN}`).join(',');

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
      use: { ...devices['Desktop Chrome'], launchOptions: { args: [hostResolverRules] } },
    },
    {
      // Browser-specific behaviours only (iframe origin, cookies, the WebCrypto
      // that the hybrid key wrapping relies on).
      name: 'firefox',
      grep: /@cross-browser/,
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: { 'network.dns.localDomains': localDomains } },
      },
    },
  ],
});
