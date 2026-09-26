import { test as base } from '@playwright/test';
import { DEMO_ACCOUNTS, type DemoAccount, signIn } from './accounts.ts';

export { expect } from '@playwright/test';

interface SignedInFixtures {
  account: DemoAccount;
}

// Every test starts signed in; a test can pick another account with
// test.use({ account: DEMO_ACCOUNTS.bob }).
export const test = base.extend<SignedInFixtures>({
  account: [DEMO_ACCOUNTS.alice, { option: true }],
  page: async ({ page, account }, use) => {
    await signIn(page, account);
    await use(page);
  },
});
