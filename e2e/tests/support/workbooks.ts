import { expect, type Page } from '@playwright/test';
import { editorFrame, pluginPanel } from './plugin.ts';
import type { NewPortion } from './portions.ts';

// The spreadsheet editor's API, on the editor frame's window: the name box's
// search, which selects a cell or a range, and the model of the active sheet.
interface SpreadsheetEditorWindow {
  Asc: {
    editor: {
      asc_findCell(reference: string): void;
      wbModel: { getActiveWs(): { getRange2(reference: string): { getValue(): string } } };
    };
  };
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

// Types into a cell through the editor's grid, and closes the warnings the
// editor shows, one per key, when the cell is not allowed for editing.
export async function typeIntoCell(page: Page, reference: string, text: string): Promise<void> {
  const editor = page.frameLocator('iframe[name="frameEditor"]');
  await editor.locator('#editor_sdk').click({ position: { x: 200, y: 200 } });
  await selectCells(page, reference);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  const warnings = editor.getByRole('alertdialog').filter({ hasText: 'This range is not allowed for editing.' });
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
