import { expect, type Page } from '@playwright/test';
import { openNewDocument } from './documents.ts';
import { editorFrame, pluginPanel } from './plugin.ts';
import type { NewPortion } from './portions.ts';
import type { HeaderFooterName } from './xlsx.ts';

const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';

// A new DIFFUSION RESTREINTE workbook from the demo template, open in the
// page's editor; its id.
export async function restrictedWorkbook(page: Page): Promise<string> {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  return documentId;
}

// The id of the first portion the panel lists.
export async function firstPortionId(page: Page): Promise<string> {
  const id = await pluginPanel(page).getByTestId('portion-item').first().getAttribute('data-portion-id');
  if (id === null) {
    throw new Error('The panel lists no portion');
  }
  return id;
}

// The spreadsheet editor's API, on the editor frame's window: the name box's
// search, which selects a cell or a range, and the model of the workbook and
// of its active sheet.
interface SpreadsheetEditorWindow {
  Asc: {
    editor: {
      asc_addWorksheet(name: string): void;
      asc_closeCellEditor(cancel: boolean): void;
      asc_findCell(reference: string): void;
      wbModel: {
        getActiveWs(): {
          getRange2(reference: string): { getValue(): string };
          selectionRange: { activeCell: { row: number; col: number } };
        };
        getWorksheetCount(): number;
        getWorksheet(index: number): { headerFooter: EditorHeaderFooter };
      };
    };
  };
}

// A sheet's headers and footers in the editor's model; a getter gives null
// where the sheet has none.
interface EditorHeaderFooter {
  getOddHeader(): EditorHeaderFooterString | null;
  getOddFooter(): EditorHeaderFooterString | null;
  getEvenHeader(): EditorHeaderFooterString | null;
  getEvenFooter(): EditorHeaderFooterString | null;
  getFirstHeader(): EditorHeaderFooterString | null;
  getFirstFooter(): EditorHeaderFooterString | null;
}

interface EditorHeaderFooterString {
  getStr(): string;
}

// Adds a sheet, as the editor's "+" button does.
export async function addSheet(page: Page, name: string): Promise<void> {
  await editorFrame(page).evaluate((sheet) => {
    (window as unknown as SpreadsheetEditorWindow).Asc.editor.asc_addWorksheet(sheet); // SAFETY: the spreadsheet editor's frame
  }, name);
}

// Selects a cell or a range, as the name box does.
export async function selectCells(page: Page, reference: string): Promise<void> {
  await editorFrame(page).evaluate((cells) => {
    (window as unknown as SpreadsheetEditorWindow).Asc.editor.asc_findCell(cells); // SAFETY: the spreadsheet editor's frame
  }, reference);
}

// What a cell holds in the editor's model, as the editor shows it.
export async function cellValue(page: Page, reference: string): Promise<string> {
  return editorFrame(page).evaluate(
    (cell) => (window as unknown as SpreadsheetEditorWindow).Asc.editor.wbModel.getActiveWs().getRange2(cell).getValue(), // SAFETY: the spreadsheet editor's frame
    reference,
  );
}

// The active cell of the active sheet, by its A1 reference, such as F4.
export async function activeCell(page: Page): Promise<string> {
  const { row, col } = await editorFrame(page).evaluate(
    () => (window as unknown as SpreadsheetEditorWindow).Asc.editor.wbModel.getActiveWs().selectionRange.activeCell, // SAFETY: the spreadsheet editor's frame
  );
  let column = '';
  for (let rest = col + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    column = String.fromCharCode('A'.charCodeAt(0) + ((rest - 1) % 26)) + column;
  }
  return `${column}${row + 1}`;
}

// Each sheet's six header and footer strings, as an author's editor holds
// them, whether its panel or a co-author's wrote them.
export async function editorHeadersAndFooters(page: Page): Promise<Record<HeaderFooterName, string | null>[]> {
  return editorFrame(page).evaluate(() => {
    const workbook = (window as unknown as SpreadsheetEditorWindow).Asc.editor.wbModel; // SAFETY: the spreadsheet editor's frame
    const text = (data: EditorHeaderFooterString | null): string | null => data?.getStr() ?? null;
    const sheets: Record<HeaderFooterName, string | null>[] = [];
    for (let index = 0; index < workbook.getWorksheetCount(); index += 1) {
      const headerFooter = workbook.getWorksheet(index).headerFooter;
      sheets.push({
        oddHeader: text(headerFooter.getOddHeader()),
        oddFooter: text(headerFooter.getOddFooter()),
        evenHeader: text(headerFooter.getEvenHeader()),
        evenFooter: text(headerFooter.getEvenFooter()),
        firstHeader: text(headerFooter.getFirstHeader()),
        firstFooter: text(headerFooter.getFirstFooter()),
      });
    }
    return sheets;
  });
}

// Types into a cell through the editor's grid, and closes the warnings the
// editor shows, one per key, when the cell is not allowed for editing.
export async function typeIntoCell(page: Page, reference: string, text: string): Promise<void> {
  await startTypingInCell(page, reference, text);
  await page.keyboard.press('Enter');
  const warnings = page.frameLocator('iframe[name="frameEditor"]').getByRole('alertdialog').filter({ hasText: 'This range is not allowed for editing.' });
  try {
    await warnings.first().waitFor({ state: 'visible', timeout: 3_000 });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      await page.keyboard.press('Escape');
      return;
    }
    throw error;
  }
  while ((await warnings.count()) > 0) {
    await warnings.first().getByRole('button', { name: 'OK' }).click();
  }
}

// Starts typing into a cell through the editor's grid, and stays in the cell:
// its cell editor stays open until leaveCell.
export async function startTypingInCell(page: Page, reference: string, text: string): Promise<void> {
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 200, y: 200 } });
  await selectCells(page, reference);
  await page.keyboard.type(text);
}

// Leaves the cell being typed in, keeping what was typed, as Enter does: a
// test that has clicked the panel since would send Enter to the panel.
export async function leaveCell(page: Page): Promise<void> {
  await editorFrame(page).evaluate(() => {
    (window as unknown as SpreadsheetEditorWindow).Asc.editor.asc_closeCellEditor(false); // SAFETY: the spreadsheet editor's frame
  });
}

// Undoes the author's last action, as Ctrl+Z does in the grid, away from the
// placeholders the tests write.
export async function undoInWorkbook(page: Page): Promise<void> {
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 700, y: 450 } });
  await page.keyboard.press('ControlOrMeta+z');
}

// Fills the panel's form and selects the cells, ready to insert.
export async function fillWorkbookPortionForm(page: Page, portion: NewPortion, cells: string): Promise<void> {
  const panel = pluginPanel(page);
  await panel.getByRole('radio', { name: portion.marking, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Portion text' }).fill(portion.text);
  await selectCells(page, cells);
}

// Inserts a portion into cells from the panel.
export async function insertWorkbookPortion(page: Page, portion: NewPortion, cells: string): Promise<void> {
  const panel = pluginPanel(page);
  const before = await panel.getByTestId('portion-item').count();
  await fillWorkbookPortionForm(page, portion, cells);
  await panel.getByRole('button', { name: 'Insert protected portion' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(before + 1);
}
