import type { Locator, Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { holdPanelCommands, pluginFrame, pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx } from './support/portions.ts';
import {
  cellValue,
  editorHeadersAndFooters,
  fillWorkbookPortionForm,
  insertWorkbookPortion,
  leaveCell,
  restrictedWorkbook,
  startTypingInCell,
  undoInWorkbook,
} from './support/workbooks.ts';
import { everySheetShows, type XlsxInspection } from './support/xlsx.ts';

const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// Empty cells of the template's sheet, where the tests insert portions.
const CELLS = 'F4:G4';
const OTHER_CELLS = 'F8:G8';
const THIRD_CELLS = 'F10:G10';
const FOURTH_CELLS = 'F12:G12';
const CELL_BEING_EDITED = 'You are typing in a cell: press Enter or Esc to leave it, then try again.';
// Bob's clearance lets him read both labels; a portion released to NATO is
// more restrictive than a document that is not.
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
// The centre sections of the headers and footers that show those markings,
// bold and in the colour the demo policy gives them.
const WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE = `&C&"-,Bold"&KE8590C${WITH_MORE_RESTRICTIVE_PORTIONS}`;
// The template's header and footer, once marked DIFFUSION RESTREINTE: its
// left and right sections stay.
const DIFFUSION_RESTREINTE_HEADER = '&LExercise NORTHWIND 26 - fictional&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_FOOTER = '&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE&RFictional workbook';

test('portions inserted into different cells at the same moment by two authors are both kept, with the right document label and page marking', async ({
  page,
  browser,
}) => {
  const documentId = await restrictedWorkbook(page);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    const alicePanel = pluginPanel(page);
    const bobPanel = pluginPanel(bob);
    await expect(bobPanel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);

    // Alice's portion is no more restrictive than the base label; Bob's is.
    const aliceText = markedText('Fictional fuel count by Alice');
    const bobText = markedText('Fictional fuel count by Bob');
    await fillWorkbookPortionForm(page, { marking: DIFFUSION_RESTREINTE, text: aliceText }, CELLS);
    await fillWorkbookPortionForm(bob, { marking: RELEASABLE_TO_NATO, text: bobText }, OTHER_CELLS);
    await Promise.all([alicePanel, bobPanel].map((panel) => panel.getByRole('button', { name: 'Insert protected portion' }).click()));

    for (const panel of [alicePanel, bobPanel]) {
      await expect.poll(async () => (await panel.getByTestId('portion-text').allTextContents()).sort()).toEqual([aliceText, bobText].sort());
      await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
    }
    const saved = await forceSavedXlsx(
      page,
      documentId,
      (xlsx) =>
        xlsx.portionParts.length === 2 &&
        xlsx.bindings[0]?.label?.categories.some((category) => category.tagName === 'Composition') === true &&
        everySheetShows(xlsx, WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE),
    );
    expect(saved.portionParts.map((part) => part.encoding)).toEqual(['ztdf', 'ztdf']);
    expect(saved.allText).not.toContain(aliceText);
    expect(saved.allText).not.toContain(bobText);
    expect(saved.worksheets[0]?.userProtectedRanges.map((range) => range.reference).sort()).toEqual([CELLS, OTHER_CELLS]);
    expect(saved.bindings).toHaveLength(1);
  } finally {
    await bob.context().close();
  }
});

// Bob's panel is held off, so that whatever page marking his workbook shows,
// Alice's panel wrote it.
test("the page marking one author's panel writes reaches a co-author's workbook", async ({ page, browser }) => {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await holdPanelCommands(await pluginFrame(bob));

    await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });

    await expect
      .poll(() => editorHeadersAndFooters(bob))
      .toEqual([
        {
          oddHeader: DIFFUSION_RESTREINTE_HEADER,
          oddFooter: DIFFUSION_RESTREINTE_FOOTER,
          evenHeader: DIFFUSION_RESTREINTE_HEADER,
          evenFooter: DIFFUSION_RESTREINTE_FOOTER,
          firstHeader: DIFFUSION_RESTREINTE_HEADER,
          firstFooter: DIFFUSION_RESTREINTE_FOOTER,
        },
      ]);
  } finally {
    await bob.context().close();
  }
});

// In fast co-editing, the spreadsheet editor undoes an author's command only
// when it can reverse every change the command made: a change of text comes
// undone, while a change of label, a deletion and an insertion, which also
// change cells, stay whole. The policy service keeps an undone portion from
// changing for a minute, hence a portion for each command.
test("in co-editing, an author's undo brings back a portion's earlier text, and leaves a change of label, a deletion and an insertion whole", async ({
  page,
  browser,
}) => {
  const documentId = await restrictedWorkbook(page);
  const original = markedText('Fictional count before its change');
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: original }, CELLS);
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional route before its raise') }, OTHER_CELLS);
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional convoy before its deletion') }, THIRD_CELLS);
  const changedId = await portionIdOf(page, 'Fictional count before its change');
  const raisedId = await portionIdOf(page, 'Fictional route before its raise');
  const deletedId = await portionIdOf(page, 'Fictional convoy before its deletion');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expect(portionItem(bob, changedId).getByTestId('portion-text')).toHaveText(original);

    await portionItem(page, changedId).getByRole('button', { name: 'Change', exact: true }).click();
    const changed = markedText('Fictional count after its change');
    await portionItem(page, changedId).getByRole('textbox', { name: 'Portion text' }).fill(changed);
    await portionItem(page, changedId).getByRole('button', { name: 'Save the change' }).click();
    await expect(portionItem(bob, changedId).getByTestId('portion-text')).toHaveText(changed);
    await undoInWorkbook(page);

    for (const editor of [page, bob]) {
      await expect(portionItem(editor, changedId).getByTestId('portion-text')).toHaveText(original);
    }

    await portionItem(page, raisedId).getByRole('button', { name: 'Change', exact: true }).click();
    await portionItem(page, raisedId).getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
    await portionItem(page, raisedId).getByRole('button', { name: 'Save the change' }).click();
    await expect(portionItem(bob, raisedId).getByTestId('portion-notice')).toHaveText('Access denied');
    await undoInWorkbook(page);

    await portionItem(page, deletedId).getByRole('button', { name: 'Delete', exact: true }).click();
    await pluginPanel(page).getByRole('button', { name: 'Delete the portion' }).click();
    await expect(portionItem(bob, deletedId)).toHaveCount(0);
    await undoInWorkbook(page);

    const inserted = markedText('Fictional depot inserted last');
    await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: inserted }, FOURTH_CELLS);
    const insertedId = await portionIdOf(page, 'Fictional depot inserted last');
    await expect(portionItem(bob, insertedId).getByTestId('portion-text')).toHaveText(inserted);
    await undoInWorkbook(page);
    // Long enough for the undos to have reached both editors.
    await page.waitForTimeout(5_000);

    for (const editor of [page, bob]) {
      await expect(portionItem(editor, raisedId).getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
      expect(await cellValue(editor, 'F8')).toBe(`${SPECIAL_FRANCE} – protected portion`);
      await expect(portionItem(editor, deletedId)).toHaveCount(0);
      expect(await cellValue(editor, 'F10')).toBe('');
      await expect(portionItem(editor, insertedId).getByTestId('portion-text')).toHaveText(inserted);
      expect(await cellValue(editor, 'F12')).toBe(`${DIFFUSION_RESTREINTE} – protected portion`);
    }
    const partOf = (xlsx: XlsxInspection, id: string) => xlsx.portionParts.find((part) => part.id === id);
    const saved = await forceSavedXlsx(
      page,
      documentId,
      (xlsx) => partOf(xlsx, changedId)?.version === '1' && partOf(xlsx, raisedId)?.version === '2' && partOf(xlsx, insertedId) !== undefined,
    );
    expect(partOf(saved, raisedId)?.label).toBe(SPECIAL_FRANCE_CODE);
    expect(partOf(saved, deletedId)).toBeUndefined();
    expect(saved.worksheets[0]?.userProtectedRanges.map((range) => range.name).sort()).toEqual([changedId, raisedId, insertedId].sort());
    expect(saved.worksheets[0]?.cellTexts.get('F8')).toBe(`${SPECIAL_FRANCE} – protected portion`);
    expect(saved.worksheets[0]?.cellTexts.has('F10')).toBe(false);
    expect(saved.worksheets[0]?.cellTexts.get('F12')).toBe(`${DIFFUSION_RESTREINTE} – protected portion`);
  } finally {
    await bob.context().close();
  }
});

// The spreadsheet editor holds back every change made while its user types in
// a cell, until they leave it: another author could meanwhile change the same
// portion, and the workbook would hold both versions of it.
test('while its author types in a cell, the panel writes nothing into the workbook and says why, then writes once they leave the cell', async ({
  page,
  browser,
}) => {
  const documentId = await restrictedWorkbook(page);
  const original = markedText('Fictional count before its change');
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: original }, CELLS);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expect(pluginPanel(bob).getByTestId('portion-text')).toHaveText([original]);
    const panel = pluginPanel(page);
    await startTypingInCell(page, 'B20', 'Fictional note');

    await panel.getByRole('radio', { name: DIFFUSION_RESTREINTE, exact: true }).check();
    await panel.getByRole('textbox', { name: 'Portion text' }).fill(markedText('Fictional count never inserted'));
    await panel.getByRole('button', { name: 'Insert protected portion' }).click();
    await expect(panel.getByTestId('insertion-failure')).toHaveText(CELL_BEING_EDITED);

    await panel.getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
    await expect(panel.getByTestId('base-label-failure')).toHaveText(CELL_BEING_EDITED);
    await expect(panel.getByLabel('Base label')).toHaveValue(DIFFUSION_RESTREINTE_CODE);

    const item = panel.getByTestId('portion-item');
    await item.getByRole('button', { name: 'Delete', exact: true }).click();
    await item.getByRole('button', { name: 'Delete the portion' }).click();
    await expect(item.getByTestId('deletion-failure')).toHaveText(CELL_BEING_EDITED);
    await item.getByTestId('deletion-confirmation').getByRole('button', { name: 'Cancel' }).click();

    await item.getByRole('button', { name: 'Change', exact: true }).click();
    const changed = markedText('Fictional count after its change');
    await item.getByRole('textbox', { name: 'Portion text' }).fill(changed);
    await item.getByRole('button', { name: 'Save the change' }).click();
    await expect(item.getByTestId('change-failure')).toHaveText(CELL_BEING_EDITED);
    await expect(pluginPanel(bob).getByTestId('portion-text')).toHaveText([original]);

    await leaveCell(page);
    await item.getByRole('button', { name: 'Save the change' }).click();

    await expect(pluginPanel(bob).getByTestId('portion-text')).toHaveText([changed]);
    await expect(pluginPanel(bob).getByTestId('portion-item')).toHaveCount(1);
    await expect.poll(() => cellValue(bob, 'B20')).toBe('Fictional note');
    const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts[0]?.version === '2');
    expect(saved.portionParts).toHaveLength(1);
    expect(saved.baseLabel).toBe(DIFFUSION_RESTREINTE_CODE);
  } finally {
    await bob.context().close();
  }
});

// A portion's entry in a person's panel.
function portionItem(page: Page, id: string): Locator {
  return pluginPanel(page).locator(`[data-portion-id="${id}"]`);
}

// The id of the portion whose text a person's panel shows.
async function portionIdOf(page: Page, text: string): Promise<string> {
  const id = await pluginPanel(page).getByTestId('portion-item').filter({ hasText: text }).getAttribute('data-portion-id');
  if (id === null) {
    throw new Error(`No portion of the panel holds ${text}`);
  }
  return id;
}
