import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { documentLogEntries, portalLog } from './support/deployment.ts';
import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { commentOnCells, mergeCells, pluginFrame, pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx, portionPageAddress } from './support/portions.ts';
import {
  cellValue,
  firstPortionId,
  insertWorkbookPortion,
  openProtectionConfirmation,
  restrictedWorkbook,
  selectCells,
  SUPPLY_ROWS,
  typeIntoCell,
} from './support/workbooks.ts';
import { everySheetShows } from './support/xlsx.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const WITH_MORE_RESTRICTIVE_PORTIONS = 'DIFFUSION RESTREINTE – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// The centre section of a workbook's headers and footers once a portion is
// more restrictive than its base label: bold, in the colour the demo SPIF
// gives DIFFUSION RESTREINTE.
const WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE = `&C&"-,Bold"&KE8590C${WITH_MORE_RESTRICTIVE_PORTIONS}`;
const WARNING =
  "The selected content already went through ONLYOFFICE in clear: it is protected from now on only, and copies made before, such as the editor's working files of this session, keep it.";
const SELECTION_EMPTY = "The selected cells are empty: type the portion's text and insert it.";
const HOLDS_MERGE_PORTION_OR_TABLE = 'The selected cells hold a merge, a portion, a table or a pivot table: select other cells.';

test('the French officer protects cells already filled, which become a SPECIAL FRANCE portion the allied officer cannot read', async ({ page, browser }) => {
  const since = new Date();
  const documentId = await restrictedWorkbook(page);
  const panel = pluginPanel(page);

  const confirmation = await openProtectionConfirmation(page, SPECIAL_FRANCE, SUPPLY_ROWS.reference);
  await expect(confirmation.getByTestId('protection-warning')).toHaveText(WARNING);
  await expect(confirmation.getByTestId('protection-preview')).toHaveText(SUPPLY_ROWS.text);
  await confirmation.getByRole('button', { name: 'Protect the selection' }).click();

  await expect(panel.getByTestId('portion-text')).toHaveText([SUPPLY_ROWS.text]);
  await expect.poll(() => cellValue(page, 'A7')).toBe(`${SPECIAL_FRANCE} – protected portion`);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  const portionId = await firstPortionId(page);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expect(pluginPanel(bob).getByTestId('portion-notice')).toHaveText('Access denied');
  } finally {
    await bob.context().close();
  }
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 1);
  expect(saved.portionParts[0]).toMatchObject({ id: portionId, label: SPECIAL_FRANCE_CODE, encoding: 'ztdf' });
  expect(saved.worksheets[0]?.userProtectedRanges).toEqual([{ name: portionId, reference: SUPPLY_ROWS.reference, users: [] }]);
  expect(saved.worksheets[0]?.mergedCells).toContain(SUPPLY_ROWS.reference);
  expect(saved.worksheets[0]?.links).toEqual([{ reference: SUPPLY_ROWS.reference, target: portionPageAddress({ documentId, portionId }) }]);
  expect(everySheetShows(saved, WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE)).toBe(true);
  // Of the two rows, only the placeholder's marking is left.
  const rowTexts = [...(saved.worksheets[0]?.cellTexts ?? [])].filter(([cell]) => /^[A-D][78]$/.test(cell));
  expect(rowTexts).toEqual([['A7', `${SPECIAL_FRANCE} – protected portion`]]);
  for (const value of ['Logistics group', 'Spare parts (crates)', 'Exercise control cell', 'Water (litres)']) {
    expect(saved.allText).not.toContain(value);
  }
  await expect
    .poll(() => documentLogEntries(since, 'Existing content protected in the panel', documentId))
    .toEqual([expect.objectContaining({ portion: portionId, after: { label: SPECIAL_FRANCE_CODE, version: 1 }, user: 'alice' })]);
  expect(portalLog(since)).not.toContain('Logistics group');
});

test('cancelling a protection changes nothing, and cells the panel cannot protect, or that changed since it read them, are refused', async ({ page }) => {
  await restrictedWorkbook(page);
  const panel = pluginPanel(page);
  const editor = page.frameLocator('iframe[name="frameEditor"]');
  const protect = panel.getByRole('button', { name: 'Protect the selection' });
  const failure = panel.getByTestId('protection-failure');

  const confirmation = await openProtectionConfirmation(page, SPECIAL_FRANCE, SUPPLY_ROWS.reference);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  expect(await cellValue(page, 'B7')).toBe('Logistics group');

  await protect.click();
  await typeIntoCell(page, 'B8', 'Fictional control cell');
  await confirmation.getByRole('button', { name: 'Protect the selection' }).click();
  await expect(failure).toHaveText('The selected content changed since the panel read it, so nothing was protected: protect it again.');
  await expect(confirmation).toHaveCount(0);
  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  expect(await cellValue(page, 'B8')).toBe('Fictional control cell');

  await selectCells(page, 'H20');
  await protect.click();
  await expect(failure).toHaveText(SELECTION_EMPTY);

  // A formula without letters, which typeIntoCell needs.
  await typeIntoCell(page, 'F10', '=1200+8000');
  await expect.poll(() => cellValue(page, 'F10')).toBe('9200');
  await selectCells(page, 'F10');
  await protect.click();
  await expect(failure).toHaveText('The selected cells hold a formula: turn it into its value first.');

  await selectCells(page, 'A4:B4,A6:B6');
  await protect.click();
  await expect(failure).toHaveText('The selection holds several blocks of cells: select one.');

  await mergeCells(await pluginFrame(page), 'A5:B5');
  await selectCells(page, 'A5:D5');
  await protect.click();
  await expect(failure).toHaveText(HOLDS_MERGE_PORTION_OR_TABLE);

  await commentOnCells(await pluginFrame(page), 'C6', 'Fictional comment on the rations');
  await selectCells(page, 'A6:D6');
  await protect.click();
  await expect(failure).toHaveText('The selected cells hold a comment, which would stay in clear: delete it or select other cells.');

  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional portion that no protection covers') }, 'F4:G4');
  await selectCells(page, 'F4:G4');
  await protect.click();
  await expect(failure).toHaveText(HOLDS_MERGE_PORTION_OR_TABLE);
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);

  // The context menu protects the cell it opened on, below the template's rows.
  await editor.locator('#editor_sdk').click({ position: { x: 400, y: 300 }, button: 'right' });
  await editor.getByText('Protect the selection', { exact: true }).click();
  await expect(failure).toHaveText(SELECTION_EMPTY);
});
