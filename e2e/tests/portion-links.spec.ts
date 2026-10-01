import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { type ContentControlLink, type DocxInspection, portionIdOfTag } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { insertEnvelope, labelXmlOf, pluginFrame, pluginPanel, unlinkCells } from './support/plugin.ts';
import {
  documentWithPortion,
  forceSavedDocx,
  forceSavedXlsx,
  insertPortion,
  leaveAndWaitForSave,
  placeholderLinks,
  portionPageAddress,
  storedDocx,
} from './support/portions.ts';
import { firstPortionId, insertWorkbookPortion } from './support/workbooks.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// The demo SPIF's code of DIFFUSION RESTREINTE.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
// Empty cells of the workbook template.
const EMPTY_CELLS = 'F4:G4';

// The links of each placeholder of a saved text document, by the id of the
// portion its tag names.
function linksByPortion(docx: DocxInspection): Record<string, ContentControlLink[]> {
  return Object.fromEntries(docx.contentControls.map((control) => [portionIdOfTag(control.tag) ?? '', control.links]));
}

// The placeholder of a portion under a label.
function placeholderOf(marking: string): string {
  return `${marking} – protected portion`;
}

test("placeholders keep their links through a co-author's session and the save that ends it", async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const aliceText = markedText('Fictional paragraph of the first author');
  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: aliceText });
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    // Bob's insertion counts the portions of his panel: Alice's must be there
    // first.
    await expect(pluginPanel(bob).getByTestId('portion-item')).toHaveCount(1);
    await insertPortion(bob, { marking: RELEASABLE_TO_NATO, text: markedText('Fictional paragraph of a co-author') });
    const aliceId = (await pluginPanel(page).getByTestId('portion-item').filter({ hasText: aliceText }).getAttribute('data-portion-id')) ?? '';

    await leaveAndWaitForSave([page, bob], documentId, 2);

    const docx = await storedDocx(page, documentId);
    const bobId = docx.portionParts.map((part) => part.id).find((id) => id !== aliceId) ?? '';
    expect(linksByPortion(docx)).toEqual({
      [aliceId]: placeholderLinks({ documentId, portionId: aliceId }, placeholderOf(DIFFUSION_RESTREINTE)),
      [bobId]: placeholderLinks({ documentId, portionId: bobId }, placeholderOf(RELEASABLE_TO_NATO)),
    });
  } finally {
    await bob.context().close();
  }
});

// The editor reads the links back from the stored file, and writes them
// again at the next save, which a change of the base label forces.
test('a placeholder keeps its link when its stored document is opened again and saved', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional paragraph saved twice') });
  await leaveAndWaitForSave([page], documentId, 1);
  await openDocument(page, documentId);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE);
  const portionId = docx.portionParts[0]?.id ?? '';
  expect(linksByPortion(docx)).toEqual({ [portionId]: placeholderLinks({ documentId, portionId }, placeholderOf(SPECIAL_FRANCE)) });
});

test("a workbook's placeholder keeps its link when the stored workbook is opened again and saved", async ({ page }) => {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional supply figures saved twice') }, EMPTY_CELLS);
  const portionId = await firstPortionId(page);
  await leaveAndWaitForSave([page], documentId, 1);
  await openDocument(page, documentId);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });

  const xlsx = await forceSavedXlsx(page, documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE);
  expect(xlsx.worksheets[0]?.links).toEqual([{ reference: EMPTY_CELLS, target: portionPageAddress({ documentId, portionId }) }]);
});

// A portion written before placeholders linked to their pages, which the
// test writes with an envelope taken from another document.
test("a placeholder without a link gets one at its portion's next change, and no other write touches it", async ({ page }) => {
  const source = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph from before links') });
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const frame = await pluginFrame(page);
  const labelXml = await labelXmlOf(frame, 'DEMO-FR', source.labelCode);
  await insertEnvelope(frame, { labelCode: source.labelCode, labelXml, placeholder: placeholderOf(DIFFUSION_RESTREINTE), envelope: source.envelope });
  // The insertion counts the portions of the panel: the first must be there.
  await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(1);
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional paragraph inserted beside it') });

  const before = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 2);
  const unlinkedId = before.portionParts.find((part) => part.label === source.labelCode)?.id ?? '';
  const insertedId = before.portionParts.find((part) => part.id !== unlinkedId)?.id ?? '';
  const inserted = placeholderLinks({ documentId, portionId: insertedId }, placeholderOf(SPECIAL_FRANCE));
  expect(linksByPortion(before)).toEqual({ [unlinkedId]: [], [insertedId]: inserted });

  const item = pluginPanel(page).locator(`[data-portion-id="${unlinkedId}"]`);
  await item.getByRole('button', { name: 'Change', exact: true }).click();
  await item.getByRole('textbox', { name: 'Portion text' }).fill(markedText('Fictional paragraph changed after links'));
  await item.getByRole('button', { name: 'Save the change' }).click();

  const after = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.find((part) => part.id === unlinkedId)?.version === '2');
  expect(linksByPortion(after)).toEqual({
    [unlinkedId]: placeholderLinks({ documentId, portionId: unlinkedId }, placeholderOf(DIFFUSION_RESTREINTE)),
    [insertedId]: inserted,
  });
});

// A workbook placeholder written before links, which the test makes by
// taking the link off a placeholder's cells.
test("a workbook placeholder without a link gets one at its portion's next change", async ({ page }) => {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional supply figures from before links') }, EMPTY_CELLS);
  const portionId = await firstPortionId(page);
  await unlinkCells(await pluginFrame(page), EMPTY_CELLS);
  await forceSavedXlsx(page, documentId, (saved) => saved.portionParts.length === 1 && saved.worksheets[0]?.links.length === 0);

  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Change', exact: true }).click();
  await item.getByRole('textbox', { name: 'Portion text' }).fill(markedText('Fictional supply figures changed after links'));
  await item.getByRole('button', { name: 'Save the change' }).click();

  const xlsx = await forceSavedXlsx(page, documentId, (saved) => saved.portionParts[0]?.version === '2');
  expect(xlsx.worksheets[0]?.links).toEqual([{ reference: EMPTY_CELLS, target: portionPageAddress({ documentId, portionId }) }]);
});

test("following a placeholder's link from the saved file shows the portion to a reader whose clearance allows it", async ({ page }) => {
  const text = markedText('Fictional paragraph read through its link');
  const portion = await documentWithPortion(page, { marking: SPECIAL_FRANCE, text });
  const [link] = (await storedDocx(page, portion.documentId)).contentControls[0]?.links ?? [];

  await page.goto(link?.target ?? '');

  await expect(page.getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
  await expect(page.getByTestId('portion-text')).toHaveText(text);
});
