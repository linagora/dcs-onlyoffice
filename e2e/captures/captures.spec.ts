import { DEMO_ACCOUNTS, signedInPage } from '../tests/support/accounts.ts';
import { dismissEditorTip, moveCursorToStart, openDocument, openNewDocument } from '../tests/support/documents.ts';
import { pageMarkingTexts } from '../tests/support/docx.ts';
import { expect, test } from '../tests/support/fixtures.ts';
import { bubble, pluginPanel } from '../tests/support/plugin.ts';
import { unmarkedText } from '../tests/support/marker.ts';
import { forceSavedDocx, insertPortion } from '../tests/support/portions.ts';
import { capture, captureTopOfPage, screenshotPath } from './screenshots.ts';

/*
 * The README's screenshots, taken in the English editor of the standalone
 * stack, with its fictional accounts. The scenario is the demo's: alice, a
 * French administrator, writes a document releasable to NATO that holds a
 * portion for French eyes only, and a second document for French eyes only;
 * bob, an allied officer, then opens them. Every portion text is fictional. It
 * carries no marker: the captures are not part of the suite whose traces the
 * CI searches, and the marker would show in the pictures.
 *
 * Run it on a fresh stack, whose document list holds only the demo document:
 * the end-to-end suite leaves its documents behind, and so does this scenario.
 * The pictures land in docs/screenshots, where the README finds them.
 */

const TEMPLATE = 'exercise-northwind.docx';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// The label of a document releasable to NATO that holds a portion for French
// eyes only, as document-label.spec.ts expects it.
const DOCUMENT_MARKING = `${RELEASABLE_TO_NATO} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
const SCREENSHOTS = new URL('../../docs/screenshots/', import.meta.url);

// alice, whom the fixture signs in, is cleared for every label of the demo
// policy and administers the clearance directory.
test('screenshots of the README', async ({ page, browser }) => {
  // A document for French eyes only, which bob's list shows without its name.
  const frenchOnly = await openNewDocument(page, TEMPLATE);
  await dismissEditorTip(page, 15_000);
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: SPECIAL_FRANCE });
  await forceSavedDocx(page, frenchOnly, (saved) => pageMarkingTexts(saved).every((text) => text === SPECIAL_FRANCE));

  // The demo document: releasable to NATO, with a portion released to NATO
  // and a portion for French eyes only.
  const documentId = await openNewDocument(page, TEMPLATE);
  const panel = pluginPanel(page);
  await panel.getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  await expect(panel.getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);
  const allied = unmarkedText('Fictional allied paragraph: liaison officers join the control cell on day 1.');
  const frenchEyesOnly = unmarkedText('Fictional French-eyes-only paragraph: the national reserve stays at the rear base.');
  await insertPortion(page, { marking: RELEASABLE_TO_NATO, text: allied });
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: frenchEyesOnly });
  await expect(panel.getByTestId('document-label-marking')).toHaveText(DOCUMENT_MARKING);
  await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === DOCUMENT_MARKING));

  // The editor and its panel, then the top of the first page.
  await moveCursorToStart(page);
  await expect(panel.getByTestId('portion-text')).toHaveCount(2);
  await panel.getByTestId('portion-item').last().scrollIntoViewIfNeeded();
  await capture(page, screenshotPath(SCREENSHOTS, 'editor'));
  await captureTopOfPage(page, screenshotPath(SCREENSHOTS, 'page-marking'));

  // The bubble, next to the cursor in the portion for French eyes only.
  await panel.getByTestId('portion-item').filter({ hasText: frenchEyesOnly }).getByRole('button').first().click();
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(frenchEyesOnly);
  await capture(page, screenshotPath(SCREENSHOTS, 'bubble'));
  await moveCursorToStart(page);

  // bob, an allied officer, reads the portion released to NATO only.
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  await dismissEditorTip(bob, 15_000);
  const bobPanel = pluginPanel(bob);
  await expect(bobPanel.getByTestId('portion-text')).toHaveText([allied]);
  await expect(bobPanel.getByTestId('portion-notice')).toHaveText(['Access denied']);
  await bobPanel.getByTestId('portion-item').last().scrollIntoViewIfNeeded();
  await capture(bob, screenshotPath(SCREENSHOTS, 'access-denied'));

  // alice changes the portion released to NATO under its lock, which bob's
  // panel shows alice holding.
  const alliedItem = panel.getByTestId('portion-item').filter({ hasText: allied });
  await alliedItem.getByRole('button', { name: 'Change', exact: true }).click();
  const changed = unmarkedText('Fictional allied paragraph, changed: liaison officers join the control cell on day 2.');
  await alliedItem.getByRole('textbox', { name: 'Portion text' }).fill(changed);
  await expect(bobPanel.getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');
  await alliedItem.getByRole('button', { name: 'Save the change' }).scrollIntoViewIfNeeded();
  await capture(page, screenshotPath(SCREENSHOTS, 'portion-change'));
  await alliedItem.getByRole('button', { name: 'Save the change' }).click();
  await expect(bobPanel.getByTestId('portion-text')).toHaveText([changed]);

  // The clearance directory's administration page.
  await page.goto('/admin/clearances');
  await expect(page.getByRole('heading', { name: 'Clearances' })).toBeVisible();
  await capture(page, screenshotPath(SCREENSHOTS, 'clearances'));

  // bob's document list, where the document for French eyes only shows its
  // marking alone.
  await bob.goto('/');
  await expect(bob.locator('tr.restricted-document', { hasText: SPECIAL_FRANCE }).first()).toBeVisible();
  await capture(bob, screenshotPath(SCREENSHOTS, 'documents'));
  await bob.context().close();
});
