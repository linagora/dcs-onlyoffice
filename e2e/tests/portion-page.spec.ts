import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, fillIdpLoginForm, signedInPage } from './support/accounts.ts';
import { ALICE, ALICE_TERMS, withTerms } from './support/clearances.ts';
import { PORTAL, withUnreadableDirectory } from './support/deployment.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, removeUserProtectedRange } from './support/plugin.ts';
import { documentWithPortion, forceSavedDocx, forceSavedXlsx, portionPagePath } from './support/portions.ts';
import { insertWorkbookPortion } from './support/workbooks.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// The demo SPIF's code of DIFFUSION RESTREINTE.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
// Alice's clearance without SPÉCIAL FRANCE.
const ALICE_WITHOUT_SPECIAL_FRANCE = { ...ALICE_TERMS, categories: ['Releasable To:NATO'] };
// Empty cells of the workbook template.
const EMPTY_CELLS = 'F4:G4';

// What the portion page shows of its portion, once it has read it.
async function shownPortion(page: Page): Promise<{ marking: string | null; text: string | null; notice: string | null }> {
  const read = page.getByTestId('portion-text').or(page.getByTestId('portion-notice'));
  await expect(read.first()).toBeVisible();
  const text = page.getByTestId('portion-text');
  const notice = page.getByTestId('portion-notice');
  return {
    marking: await page.getByTestId('portion-marking').textContent(),
    text: (await text.count()) === 0 ? null : await text.textContent(),
    notice: (await notice.count()) === 0 ? null : await notice.textContent(),
  };
}

// The rows of the journal page for a document.
async function journalRows(page: Page, documentId: string): Promise<number> {
  await page.goto(`/admin/journal?${new URLSearchParams({ document: documentId }).toString()}`);
  return page.getByRole('row').count();
}

test('a reader whose clearance allows its label reads a portion on its portion page, as the platform stores it @cross-browser', async ({ page }) => {
  const text = markedText('Fictional paragraph read outside the editor');
  const portion = await documentWithPortion(page, { marking: SPECIAL_FRANCE, text });
  const rows = await journalRows(page, portion.documentId);

  const answer = await page.goto(portionPagePath(portion));

  expect(answer?.status()).toBe(200);
  expect(await shownPortion(page)).toEqual({ marking: SPECIAL_FRANCE, text, notice: null });
  await expect(page.getByText('as the platform stores it now')).toBeVisible();
  // The portal hands the page the portion's part as stored: its envelope,
  // never its text.
  const part = await browserFetch(page, `${portionPagePath(portion)}/part`);
  expect(part.status).toBe(200);
  expect(part.body.toString('utf8')).not.toContain(text);
  // Reading leaves the journal as it was.
  expect(await journalRows(page, portion.documentId)).toBe(rows);
});

test('a reader who may open the document but not read the portion gets "Access denied", and someone who may not open it gets the document\'s refusal', async ({
  page,
  browser,
}) => {
  const portion = await documentWithPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional paragraph for French eyes only') });
  await openDocument(page, portion.documentId);
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, portion.documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  const chloe = await signedInPage(browser, DEMO_ACCOUNTS.chloe);

  await bob.goto(portionPagePath(portion));
  const refused = await chloe.goto(portionPagePath(portion));

  expect(await shownPortion(bob)).toEqual({ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' });
  expect(refused?.status()).toBe(403);
  await expect(chloe.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  // The refusal shows the base label's marking, nothing of the portion.
  await expect(chloe.locator('main')).toContainText(DIFFUSION_RESTREINTE);
  await expect(chloe.locator('main')).not.toContainText(SPECIAL_FRANCE);
  expect(await chloe.content()).not.toContain(portion.documentId);
  expect((await browserFetch(chloe, `${portionPagePath(portion)}/part`)).status).toBe(403);
  await bob.context().close();
  await chloe.context().close();
});

test('a reader who is not signed in signs in, and comes back to the portion page', async ({ page, browser }) => {
  const text = markedText('Fictional paragraph read after signing in');
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: PORTAL });
  const reader = await context.newPage();
  // Nothing of the portion goes to someone who is not signed in.
  await reader.goto('/healthz');
  expect((await browserFetch(reader, `${portionPagePath(portion)}/part`)).status).toBe(401);

  await reader.goto(portionPagePath(portion));
  await expect(reader).toHaveURL(/\/\/idp\./);
  await fillIdpLoginForm(reader, DEMO_ACCOUNTS.alice);

  await expect(reader).toHaveURL(new RegExp(`${portionPagePath(portion)}$`));
  expect(await shownPortion(reader)).toEqual({ marking: DIFFUSION_RESTREINTE, text, notice: null });
  await context.close();
});

// OpenTDF decides at each opening of the page, from the clearance directory.
test('a revocation made on the administration page applies at the next opening of the portion page', async ({ page, browser }) => {
  const text = markedText('Fictional paragraph read before and after a revocation');
  const portion = await documentWithPortion(page, { marking: SPECIAL_FRANCE, text });

  await withTerms(browser, ALICE, ALICE_WITHOUT_SPECIAL_FRANCE, ALICE_TERMS, async () => {
    await page.goto(portionPagePath(portion));
    expect(await shownPortion(page)).toEqual({ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' });
  });
  await page.goto(portionPagePath(portion));
  expect(await shownPortion(page)).toEqual({ marking: SPECIAL_FRANCE, text, notice: null });
});

test('the portion page shows a changed portion\'s new text', async ({ page }) => {
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph before its change') });
  const after = markedText('Fictional paragraph after its change');
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Change', exact: true }).click();
  await item.getByRole('textbox', { name: 'Portion text' }).fill(after);
  await item.getByRole('button', { name: 'Save the change' }).click();
  await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts[0]?.content !== portion.envelope);

  await page.goto(portionPagePath(portion));

  expect(await shownPortion(page)).toEqual({ marking: DIFFUSION_RESTREINTE, text: after, notice: null });
});

test('the portion page says that the stored document no longer holds a deleted portion', async ({ page }) => {
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph deleted later') });
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Delete', exact: true }).click();
  await item.getByRole('button', { name: 'Delete the portion' }).click();
  await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts.length === 0);

  await page.goto(portionPagePath(portion));

  await expect(page.getByTestId('portion-notice')).toHaveText('The stored document no longer holds this portion.');
  await expect(page.getByTestId('portion-text')).toHaveCount(0);
});

// As everywhere in the platform, a portion goes with its placeholder, here a
// workbook's protected range, whatever becomes of its part.
test('a portion whose placeholder the stored file no longer holds is reported as no longer stored, though its part stays', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind-logistics.xlsx');
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional supply figures whose range goes') }, EMPTY_CELLS);
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets[0]?.userProtectedRanges.length === 1);
  const portionId = saved.portionParts[0]?.id ?? '';

  await removeUserProtectedRange(await pluginFrame(page), portionId);
  const withoutRange = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets[0]?.userProtectedRanges.length === 0);
  await page.goto(portionPagePath({ documentId, portionId }));

  expect(withoutRange.portionParts.map((part) => part.id)).toEqual([portionId]);
  await expect(page.getByTestId('portion-notice')).toHaveText('The stored document no longer holds this portion.');
});

test('a portion that cannot be read for now says so, and is read once the page is reloaded', async ({ page }) => {
  const text = markedText('Fictional paragraph read once the key service decides');
  const portion = await documentWithPortion(page, { marking: SPECIAL_FRANCE, text });

  await withUnreadableDirectory(async () => {
    await page.goto(portionPagePath(portion));
    await expect(page.getByTestId('portion-notice')).toHaveText('Could not decrypt (the key service could not decide whether you may read it).');
    await expect(page.getByText('Reload the page to try again.')).toBeVisible();
  });

  await expect
    .poll(
      async () => {
        await page.reload();
        return (await shownPortion(page)).text;
      },
      { timeout: 60_000 },
    )
    .toBe(text);
});

test('a reader reads a workbook portion on its portion page', async ({ page }) => {
  const text = markedText('Fictional supply figures read outside the editor');
  const documentId = await openNewDocument(page, 'exercise-northwind-logistics.xlsx');
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text }, EMPTY_CELLS);
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 1);
  const portionId = saved.portionParts[0]?.id ?? '';

  await page.goto(portionPagePath({ documentId, portionId }));

  expect(await shownPortion(page)).toEqual({ marking: SPECIAL_FRANCE, text, notice: null });
});
