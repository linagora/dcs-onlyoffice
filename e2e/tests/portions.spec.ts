import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, storedDocx } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('an inserted portion keeps its text out of the document body', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional protected paragraph ${Date.now()}`;

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });

  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-marking')).toHaveText([SPECIAL_FRANCE]);
  await expect(panel.getByTestId('portion-text')).toHaveText([secret]);

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 1);
  expect(docx.contentControls).toEqual([
    { alias: 'Protected portion', tag: expect.any(String), lock: 'sdtContentLocked', text: `${SPECIAL_FRANCE} – protected portion` },
  ]);
  const tag: unknown = JSON.parse(docx.contentControls[0]?.tag ?? 'null');
  expect(tag).toEqual({ v: 1, id: expect.stringMatching(UUID), label: 'DEMO-FR:2/1.1' });
  const portionId = (tag as { id: string }).id; // SAFETY: shape asserted just above
  expect(docx.portionParts).toEqual([
    { id: portionId, version: '1', label: 'DEMO-FR:2/1.1', labelXml: expect.any(String), content: secret },
  ]);
  expect(docx.portionParts[0]?.labelXml).toContain('<slab:GenericValue>SPECIAL FRANCE</slab:GenericValue>');
  expect(docx.packageText).not.toContain(secret);
});

// Undocumented behaviour 4: content-control tags and Custom XML parts survive
// the Document Server's DOCX save and a later reopening.
test('portions survive saving to DOCX and reopening', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional reopened paragraph ${Date.now()}`;
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  // Fast co-editing sends changes asynchronously; let them reach the server.
  await page.waitForTimeout(2_000);

  await page.goto('/');
  await expect
    .poll(async () => (await storedDocx(page, documentId)).portionParts.length, { timeout: 90_000, intervals: [3_000] })
    .toBe(1);

  await openDocument(page, documentId);
  await expect(pluginPanel(page).getByTestId('portion-text')).toHaveText([secret]);
  await expect(pluginPanel(page).getByTestId('portion-marking')).toHaveText([SPECIAL_FRANCE]);
});

// One editor command inserts both the block and its part; the panel's regular
// rereading of the document must not add undo steps of its own.
test('a single undo removes an inserted portion and its part', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: `Fictional undone paragraph ${Date.now()}` });
  // Let the panel reread the document a few times.
  await page.waitForTimeout(7_000);

  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('ControlOrMeta+z');

  await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(0);
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.contentControls.length === 0);
  expect(docx.portionParts).toEqual([]);
});

test('a portion inserted in the middle of a paragraph goes after it and leaves it whole', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const paragraph = `Fictional paragraph ${Date.now()} ends here`;
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(paragraph);
  for (const _character of ' ends here') {
    await page.keyboard.press('ArrowLeft');
  }

  const panel = pluginPanel(page);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Portion text' }).fill(`Fictional protected text ${Date.now()}`);
  await panel.getByRole('button', { name: 'Insert protected portion' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.contentControls.length === 1 && saved.bodyText.includes('Fictional paragraph'));
  const lines = docx.bodyText.split('\n');
  const index = lines.indexOf(paragraph);
  expect(index, 'the paragraph stays whole').toBeGreaterThanOrEqual(0);
  expect(lines[index + 1]).toBe(`${SPECIAL_FRANCE} – protected portion`);
});
