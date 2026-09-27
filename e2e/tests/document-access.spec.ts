import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { storedDocx } from './support/portions.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';

// Gives the open document a base label. The panel has the portal save the
// document at once, so the stored file, which the portal checks, soon
// carries it.
async function setBaseLabel(page: Page, documentId: string, marking: string, classification: string, category: string | null): Promise<void> {
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: marking });
  await expect
    .poll(
      async () => {
        const label = (await storedDocx(page, documentId)).bindings[0]?.label;
        return label?.classification === classification && (category === null || label.categories.some((entry) => entry.values.includes(category)));
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
}

async function restrictedRows(page: Page, marking: string): Promise<number> {
  await page.goto('/');
  return page.locator('tr.restricted-document', { hasText: marking }).count();
}

// A document opens only for people whose clearance allows its base label,
// which covers its content in clear. The others see it listed with that
// label's marking only, since its name can be sensitive too.
test('a document beyond a clearance is listed without its name, and does not open', async ({ page, browser }) => {
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  const before = await restrictedRows(bob, SPECIAL_FRANCE);

  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await setBaseLabel(page, documentId, SPECIAL_FRANCE, 'DIFFUSION RESTREINTE', 'SPECIAL FRANCE');

  expect(await restrictedRows(bob, SPECIAL_FRANCE)).toBe(before + 1);
  expect(await bob.content()).not.toContain(documentId);

  for (const address of ['edit', 'view', 'download']) {
    const response = await browserFetch(bob, `/documents/${documentId}/${address}`);
    expect(response.status).toBe(403);
    const refusal = response.body.toString('utf8');
    expect(refusal).toContain(SPECIAL_FRANCE);
    expect(refusal).not.toContain(documentId);
  }
  expect((await browserFetch(bob, `/documents/${documentId}/forcesave`, 'POST')).status).toBe(403);
  await bob.context().close();
});

// Anyone may raise a base label; lowering it is offered only to
// administrators whose clearance allows the current label.
test('lowering the base label is offered only to administrators cleared for it', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await setBaseLabel(page, documentId, DIFFUSION_RESTREINTE, 'DIFFUSION RESTREINTE', null);
  const baseLabelChoices = (reader: Page): Promise<string[]> => pluginPanel(reader).getByLabel('Base label').locator('option').allTextContents();

  await expect.poll(() => baseLabelChoices(page)).toEqual([NON_PROTEGE, DIFFUSION_RESTREINTE, SPECIAL_FRANCE, RELEASABLE_TO_NATO]);

  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  await expect.poll(() => baseLabelChoices(bob)).toEqual([DIFFUSION_RESTREINTE, SPECIAL_FRANCE, RELEASABLE_TO_NATO]);
  await bob.context().close();
});
