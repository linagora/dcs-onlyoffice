import type { Locator, Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { editorFrame, pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx } from './support/portions.ts';
import { insertWorkbookPortion, restrictedWorkbook } from './support/workbooks.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const WITH_MORE_RESTRICTIVE_PORTIONS = 'DIFFUSION RESTREINTE – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// The colours the demo SPIF gives NON PROTEGE and DIFFUSION RESTREINTE, as
// the browser computes them, with the text colour that reads best on each:
// white on the dark green, black on the orange.
const NON_PROTEGE_COLORS = { background: 'rgb(46, 125, 50)', text: 'rgb(255, 255, 255)' };
const DIFFUSION_RESTREINTE_COLORS = { background: 'rgb(232, 89, 12)', text: 'rgb(0, 0, 0)' };

// The strips above and below the editor that show a workbook's screen
// marking.
function screenMarkings(page: Page): Locator {
  return page.getByTestId('screen-marking');
}

async function expectScreenMarking(page: Page, text: string, colors: { background: string; text: string }): Promise<void> {
  await expect(screenMarkings(page)).toHaveText([text, text]);
  for (const strip of await screenMarkings(page).all()) {
    await expect(strip).toHaveCSS('background-color', colors.background);
    await expect(strip).toHaveCSS('color', colors.text);
  }
}

test("a workbook's page shows its document label above and below the editor, which follows the panel's, and a text document's page shows none", async ({
  page,
  browser,
}) => {
  const documentId = await openNewDocument(page, 'exercise-northwind-logistics.xlsx');
  // A new workbook has no label yet, which counts as the least restrictive.
  await expectScreenMarking(page, NON_PROTEGE, NON_PROTEGE_COLORS);
  // Above and below the editor, outside its frame, on the screen.
  const [top, bottom] = await screenMarkings(page).all();
  const editorBox = await page.locator('iframe[name="frameEditor"]').boundingBox();
  const bottomBox = await bottom?.boundingBox();
  expect((await top?.boundingBox())?.y ?? Infinity).toBeLessThan(editorBox?.y ?? 0);
  expect(bottomBox?.y ?? 0).toBeGreaterThanOrEqual((editorBox?.y ?? 0) + (editorBox?.height ?? 0));
  expect((bottomBox?.y ?? Infinity) + (bottomBox?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expectScreenMarking(page, DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE_COLORS);

  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expectScreenMarking(bob, DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE_COLORS);
    await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional portion that raises the document label') }, 'F4:G4');
    await expectScreenMarking(page, WITH_MORE_RESTRICTIVE_PORTIONS, DIFFUSION_RESTREINTE_COLORS);
    await expectScreenMarking(bob, WITH_MORE_RESTRICTIVE_PORTIONS, DIFFUSION_RESTREINTE_COLORS);
  } finally {
    await bob.context().close();
  }

  await openNewDocument(page, 'exercise-northwind.docx');
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(NON_PROTEGE);
  await expect(screenMarkings(page)).toHaveCount(0);
});

test("as a workbook's page opens, it shows the document label the stored file names, even before the panel speaks", async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  await forceSavedXlsx(page, documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE);
  await page.goto('/');

  // Without its panel, the page has only the stored label to show.
  await page.route('**/plugin/**', async (route) => route.abort());
  await page.goto(`/documents/${documentId}/edit`);
  await waitForEditorReady(page);

  await expectScreenMarking(page, DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE_COLORS);
});

test("a workbook's viewer shows its screen marking, which a message from another origin does not change", async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  await forceSavedXlsx(page, documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE);

  await page.goto(`/documents/${documentId}/view`);
  await waitForEditorReady(page);
  await expectScreenMarking(page, DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE_COLORS);

  // The Document Server's frame speaks from its own origin.
  await editorFrame(page).evaluate(() => {
    window.top?.postMessage({ type: 'dcs-screen-marking', marking: { text: 'FICTIONAL FORGED MARKING', color: '#000000' } }, '*');
  });
  await page.waitForTimeout(1_000);
  await expectScreenMarking(page, DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE_COLORS);

  // The same message from the portal's own origin, the panel's, is believed.
  await page.evaluate(() => {
    window.postMessage({ type: 'dcs-screen-marking', marking: { text: 'FICTIONAL SAME-ORIGIN MARKING', color: '#000000' } }, window.location.origin);
  });
  await expectScreenMarking(page, 'FICTIONAL SAME-ORIGIN MARKING', { background: 'rgb(0, 0, 0)', text: 'rgb(255, 255, 255)' });
});
