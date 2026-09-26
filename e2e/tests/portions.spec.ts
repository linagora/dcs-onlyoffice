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
    { tag: expect.any(String), lock: 'sdtContentLocked', text: `${SPECIAL_FRANCE} – protected portion` },
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
