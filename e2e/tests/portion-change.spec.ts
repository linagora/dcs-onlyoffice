import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { deploymentSetting } from './support/deployment.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { type MarkedText, markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion } from './support/portions.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';

interface InsertedPortion {
  documentId: string;
  portionId: string;
  labelCode: string;
  envelope: string;
}

// A new document with one DIFFUSION RESTREINTE portion, as stored.
async function documentWithPortion(page: Page, text: MarkedText): Promise<InsertedPortion> {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text });
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 1);
  const part = docx.portionParts[0];
  if (part?.id === null || part?.id === undefined || part.label === null) {
    throw new Error('The saved DOCX holds no labelled portion part');
  }
  return { documentId, portionId: part.id, labelCode: part.label, envelope: part.content };
}

// What the policy service answers someone asking for a portion's lock
// through the portal's relay.
async function lockAnswer(page: Page, portion: InsertedPortion): Promise<number> {
  const url = `/api/policy/documents/${portion.documentId}/portions/${portion.portionId}/lock`;
  return (await browserFetch(page, url, 'POST', { code: portion.labelCode, renewal: false })).status;
}

// The portion locks of a document that the policy service lists.
async function listedLocks(page: Page, portion: InsertedPortion): Promise<unknown> {
  return JSON.parse((await browserFetch(page, `/api/policy/documents/${portion.documentId}/locks`)).body.toString('utf8'));
}

test('a portion changed under its lock is shown being changed to a co-author, then in its new version', async ({ page, browser }) => {
  const before = markedText('Fictional paragraph before its change');
  const portion = await documentWithPortion(page, before);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  const bobPortion = pluginPanel(bob).getByTestId('portion-item');
  await expect(bobPortion.getByTestId('portion-text')).toHaveText(before);

  const alicePortion = pluginPanel(page).getByTestId('portion-item');
  await alicePortion.getByRole('button', { name: 'Change', exact: true }).click();
  const textbox = alicePortion.getByRole('textbox', { name: 'Portion text' });
  await expect(textbox).toHaveValue(before);

  // bob sees who changes it, is offered no change and cannot take its lock.
  await expect(bobPortion.getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');
  await expect(bobPortion.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
  expect(await lockAnswer(bob, portion)).toBe(409);

  const after = markedText('Fictional paragraph after its change');
  await textbox.fill(after);
  await alicePortion.getByRole('button', { name: 'Save the change' }).click();

  await expect(bobPortion.getByTestId('portion-text')).toHaveText(after);
  await expect(bobPortion.getByTestId('portion-status')).toHaveCount(0);
  await expect(bobPortion.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
  const docx = await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts[0]?.version === '2');
  expect(docx.portionParts).toEqual([
    { id: portion.portionId, version: '2', label: portion.labelCode, labelXml: expect.any(String), encoding: 'ztdf', content: expect.any(String) },
  ]);
  expect(docx.portionParts[0]?.content).not.toBe(portion.envelope);
  await bob.context().close();
});

test('closing the editor releases its lock at once', async ({ page, browser }) => {
  const portion = await documentWithPortion(page, markedText('Fictional paragraph left open'));
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  await pluginPanel(page).getByTestId('portion-item').getByRole('button', { name: 'Change', exact: true }).click();
  await expect(pluginPanel(bob).getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');

  await page.goto('/');

  // Well within the 20 seconds after which the lock would lapse.
  await expect.poll(async () => listedLocks(bob, portion), { timeout: 5_000 }).toEqual([]);
  expect(await lockAnswer(bob, portion)).toBe(200);
  await bob.context().close();
});

test('the lock of an author who lost their connection lapses, and a co-author takes it', async ({ page, browser }) => {
  const lease = Number(deploymentSetting('PORTION_LOCK_LEASE_SECONDS'));
  expect(lease, 'the stack runs with PORTION_LOCK_LEASE_SECONDS=20, as deploy/.env.example sets it').toBeLessThanOrEqual(60);
  const portion = await documentWithPortion(page, markedText('Fictional paragraph left locked'));
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  const bobPortion = pluginPanel(bob).getByTestId('portion-item');

  await pluginPanel(page).getByTestId('portion-item').getByRole('button', { name: 'Change', exact: true }).click();
  await expect(bobPortion.getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');
  await page.context().setOffline(true);

  await expect(bobPortion.getByRole('button', { name: 'Change', exact: true })).toBeVisible({ timeout: (lease + 15) * 1000 });
  await bobPortion.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(bobPortion.getByRole('textbox', { name: 'Portion text' })).toBeVisible();
  await page.context().setOffline(false);
  await bob.context().close();
});

// The web SDK keeps the KAS's key once it has encrypted, so the failure comes
// from a label that gives no attribute value, which the panel never uses.
test('a change whose text cannot be encrypted leaves the portion as it was, and its lock free', async ({ page }) => {
  const before = markedText('Fictional paragraph that stays');
  const portion = await documentWithPortion(page, before);
  const panel = pluginPanel(page);
  const item = panel.getByTestId('portion-item');
  await item.getByRole('button', { name: 'Change', exact: true }).click();
  const attributes = '**/api/policy/policies/*/labels/attributes';
  await page.route(attributes, async (route) => route.fulfill({ json: { attributes: [] } }));
  await item.getByRole('textbox', { name: 'Portion text' }).fill(markedText('Fictional paragraph never sealed'));

  await item.getByRole('button', { name: 'Save the change' }).click();

  await expect(item.getByTestId('portion-status')).toContainText('The text could not be encrypted, so the portion is unchanged');
  await page.unroute(attributes);
  await expect(item.getByTestId('portion-text')).toHaveText(before);
  await expect(item.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
  expect(await listedLocks(page, portion)).toEqual([]);
  const docx = await forceSavedDocx(page, portion.documentId, () => true);
  expect(docx.portionParts.map((part) => part.version)).toEqual(['1']);
});

test('a changed text is limited to 20,000 characters, as a new one', async ({ page }) => {
  await documentWithPortion(page, markedText('Fictional paragraph to lengthen'));
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Change', exact: true }).click();

  await item.getByRole('textbox', { name: 'Portion text' }).fill(markedText('x'.repeat(20_001)));

  await expect(item.getByTestId('text-too-long')).toBeVisible();
  await expect(item.getByRole('button', { name: 'Save the change' })).toBeDisabled();
  await item.getByRole('button', { name: 'Cancel' }).click();
  await expect(item.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
});
