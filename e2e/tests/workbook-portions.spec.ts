import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { documentLogEntries } from './support/deployment.ts';
import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, removeUserProtectedRange } from './support/plugin.ts';
import { forceSavedXlsx, portionPageAddress, shownPortions } from './support/portions.ts';
import {
  cellValue,
  fillWorkbookPortionForm,
  firstPortionId,
  insertWorkbookPortion,
  restrictedWorkbook,
  typeIntoCell,
  undoInWorkbook,
} from './support/workbooks.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const WITH_MORE_RESTRICTIVE_PORTIONS = 'DIFFUSION RESTREINTE – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// The template's header once the workbook is marked DIFFUSION RESTREINTE, in
// bold and in the colour the demo policy gives the label.
const DIFFUSION_RESTREINTE_HEADER = '&LExercise NORTHWIND 26 - fictional&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE';
// What the placeholder of a SPECIAL FRANCE portion shows, in English.
const PLACEHOLDER = `${SPECIAL_FRANCE} – protected portion`;
const CELL_INSERTION_HINT = 'Select empty cells, pick a label and type the text: the portion goes into the selected cells.';
const CELLS_OCCUPIED = 'The selected cells hold a value, a merge or another portion: select empty cells.';
// Two empty cells of the template's sheet, and two that hold a unit's name
// and its supply.
const EMPTY_CELLS = 'F4:G4';
const FILLED_CELLS = 'B4:C4';

test('a portion inserted into empty cells is stored in a merged, marked placeholder under a range that lists no editor', async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  const text = markedText('Fictional convoy route, held in cells');

  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text }, EMPTY_CELLS);

  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-text')).toHaveText([text]);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  const portionId = await firstPortionId(page);
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 1 && xlsx.bindings[0]?.signed === true);
  const [sheet] = saved.worksheets;
  expect(sheet?.userProtectedRanges).toEqual([{ name: portionId, reference: EMPTY_CELLS, users: [] }]);
  expect(sheet?.mergedCells).toContain(EMPTY_CELLS);
  // The whole placeholder links to the portion's page.
  expect(sheet?.links).toEqual([{ reference: EMPTY_CELLS, target: portionPageAddress({ documentId, portionId }) }]);
  expect(sheet?.cellTexts.get('F4')).toBe(PLACEHOLDER);
  expect(saved.portionParts).toEqual([expect.objectContaining({ id: portionId, label: SPECIAL_FRANCE_CODE, encoding: 'ztdf' })]);
  expect(saved.portionParts[0]?.content).not.toBe('');
  expect(saved.bindings[0]?.label?.categories.flatMap((category) => category.values)).toContain('MORE RESTRICTIVE PORTIONS');
  expect(saved.allText).not.toContain(text);
});

test('a co-author refused a portion sees "Access denied", and no one can type into its placeholder', async ({ page, browser }) => {
  const documentId = await restrictedWorkbook(page);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    // The allied officer co-edits the workbook before the portion exists: its
    // range reaches his editor live.
    await openDocument(bob, documentId);
    const text = markedText('Fictional supply figures, held in cells');

    await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text }, EMPTY_CELLS);

    await expect(pluginPanel(page).getByTestId('portion-text')).toHaveText([text]);
    await expect.poll(() => shownPortions(bob)).toEqual([{ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' }]);
    await expect.poll(() => cellValue(bob, 'F4')).toBe(PLACEHOLDER);
    for (const editor of [page, bob]) {
      // Typing reaches the grid, but not the placeholder.
      await typeIntoCell(editor, 'H10', 'Z');
      await expect.poll(() => cellValue(editor, 'H10')).toBe('Z');
      await typeIntoCell(editor, 'F4', 'X');
      expect(await cellValue(editor, 'F4')).toBe(PLACEHOLDER);
    }
  } finally {
    await bob.context().close();
  }
});

test('cells that hold a value or a formula are refused, and nothing is written', async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  const panel = pluginPanel(page);
  // A formula whose result is empty counts as much as a value.
  await typeIntoCell(page, 'H4', '=""');
  await expect.poll(() => cellValue(page, 'H4')).toBe('');
  const before = await cellValue(page, 'B4');

  for (const cells of [FILLED_CELLS, 'H4:I4']) {
    await fillWorkbookPortionForm(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional text for occupied cells') }, cells);
    await panel.getByRole('button', { name: 'Insert protected portion' }).click();

    await expect(panel.getByTestId('insertion-failure')).toHaveText(CELLS_OCCUPIED);
  }

  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  expect(await cellValue(page, 'B4')).toBe(before);
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.baseLabel === 'DEMO-FR:2');
  expect(saved.portionParts).toEqual([]);
  expect(saved.worksheets[0]?.userProtectedRanges).toEqual([]);
  expect(saved.worksheets[0]?.mergedCells).toEqual([]);
});

// One editor command writes the placeholder, its range, the portion's part,
// the document label and the page marking; the panel's regular rereading of
// the workbook adds no undo steps of its own.
test('a single undo removes a portion inserted into cells, with its placeholder, its range and its part', async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional undone count') }, EMPTY_CELLS);
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  // Let the panel reread the workbook a few times.
  await page.waitForTimeout(7_000);

  await undoInWorkbook(page);

  await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(0);
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText('DIFFUSION RESTREINTE');
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets[0]?.headersAndFooters.strings.oddHeader === DIFFUSION_RESTREINTE_HEADER);
  expect(saved.portionParts).toEqual([]);
  expect(saved.worksheets[0]?.userProtectedRanges).toEqual([]);
  expect(saved.worksheets[0]?.mergedCells).toEqual([]);
  expect(saved.worksheets[0]?.links).toEqual([]);
  expect(saved.worksheets[0]?.cellTexts.has('F4')).toBe(false);
});

test("the spreadsheet editor's context menu and Insert tab offer to insert a protected portion into cells", async ({ page }) => {
  await restrictedWorkbook(page);
  const editor = page.frameLocator('iframe[name="frameEditor"]');
  const requested = pluginPanel(page).getByTestId('insertion-requested');

  await editor.locator('#editor_sdk').click({ position: { x: 400, y: 300 }, button: 'right' });
  await editor.getByText('Insert protected portion', { exact: true }).click();
  await expect(requested).toHaveText(CELL_INSERTION_HINT);

  await editor.getByText('Insert', { exact: true }).first().click();
  // The toolbar breaks the caption over two lines.
  await editor.getByRole('button', { name: /^Protected\s*portion$/ }).click();
  await expect(requested).toHaveText(CELL_INSERTION_HINT);
});

test('a save that removes the range of a portion is logged as removing the portion', async ({ page }) => {
  const since = new Date();
  const documentId = await restrictedWorkbook(page);
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional portion whose range goes') }, EMPTY_CELLS);
  const portionId = await firstPortionId(page);
  await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets[0]?.userProtectedRanges.length === 1);

  await removeUserProtectedRange(await pluginFrame(page), portionId);

  await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets[0]?.userProtectedRanges.length === 0);
  await expect.poll(() => documentLogEntries(since, 'Portion removed', documentId)).toContainEqual(expect.objectContaining({ portion: portionId }));
});
