import { expect, test } from '@playwright/test';
import { DEMO_ACCOUNTS, fillIdpLoginForm, signIn } from './support/accounts.ts';
import { editorPageConfig, waitForEditorReady, watchEditorLoads } from './support/documents.ts';

test('an anonymous visitor signs in at the IdP and lands on the page they asked for', async ({ page }) => {
  await page.goto('/documents/exercise-northwind/edit');
  await expect(page).toHaveURL(/\/\/idp\./);

  await fillIdpLoginForm(page, DEMO_ACCOUNTS.bob);

  await expect(page).toHaveURL(/\/documents\/exercise-northwind\/edit$/);
});

test('a signed-in user opens a document under their own name', async ({ page }) => {
  watchEditorLoads(page);
  await signIn(page, DEMO_ACCOUNTS.alice);
  await page.getByRole('link', { name: 'exercise-northwind.docx', exact: true }).click();
  await waitForEditorReady(page);

  const { editorConfig } = await editorPageConfig(page);
  expect(editorConfig.user).toEqual({ id: 'alice', name: 'Alice Martin' });
});

test('signing out ends both the portal session and the IdP session', async ({ page }) => {
  await signIn(page, DEMO_ACCOUNTS.alice);

  await page.getByRole('button', { name: 'Sign out' }).click();

  // Back on the portal, the visitor must sign in again: the IdP no longer
  // holds a session that would sign them in silently.
  await expect(page).toHaveURL(/\/\/idp\./);
  await expect(page.locator('input[name="user"]')).toBeVisible();
});

test("the portal knows the signed-in user's groups", async ({ page }) => {
  await signIn(page, DEMO_ACCOUNTS.alice);

  const groups = await page.evaluate(async () => {
    const me: unknown = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    return typeof me === 'object' && me !== null && 'groups' in me && Array.isArray(me.groups)
      ? me.groups.filter((group): group is string => typeof group === 'string')
      : null;
  });
  // The IdP does not keep the order of groups stable.
  expect(groups?.sort()).toEqual(['dcs-maquette', 'dcs-maquette-admin']);
});
