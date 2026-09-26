import { defineConfig, devices } from '@playwright/test';

const domain = process.env.DOMAIN ?? 'dcs.test';

// The stack is reached through its public host names; map them to the local
// reverse proxy so that no hosts-file change is needed on developer machines.
const hostResolverRules = `--host-resolver-rules=MAP *.${domain} 127.0.0.1`;

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `https://portail.${domain}`,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: [hostResolverRules] } },
    },
  ],
});
