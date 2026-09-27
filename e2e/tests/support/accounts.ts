import { type Browser, expect, type Page } from '@playwright/test';
import { watchEditorLoads } from './documents.ts';

export interface DemoAccount {
  login: string;
  password: string;
  name: string;
}

// Fictional accounts of the local IdP (deploy/idp/users.json).
export const DEMO_ACCOUNTS = {
  alice: { login: 'alice', password: 'alice', name: 'Alice Martin' },
  bob: { login: 'bob', password: 'bob', name: 'Bob Walker' },
  chloe: { login: 'chloe', password: 'chloe', name: 'Chloe Bernard' },
  // No clearance in the directory.
  dan: { login: 'dan', password: 'dan', name: 'Dan Moreau' },
  // A clearance whose validity period has ended.
  erin: { login: 'erin', password: 'erin', name: 'Erin Petit' },
} as const satisfies Record<string, DemoAccount>;

export async function fillIdpLoginForm(page: Page, account: DemoAccount): Promise<void> {
  await page.locator('input[name="user"]').fill(account.login);
  await page.locator('input[name="password"]').fill(account.password);
  await page.locator('button[type="submit"]').first().click();
}

export async function signIn(page: Page, account: DemoAccount): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/\/idp\./);
  await fillIdpLoginForm(page, account);
  await expect(page.getByText(`Signed in as ${account.name}`)).toBeVisible();
}

// A second, independent browser session, for co-editing scenarios.
export async function signedInPage(browser: Browser, account: DemoAccount): Promise<Page> {
  const domain = process.env.DOMAIN ?? 'dcs.test';
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: `https://portail.${domain}` });
  const page = await context.newPage();
  watchEditorLoads(page);
  await signIn(page, account);
  return page;
}
