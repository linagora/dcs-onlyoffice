import { expect, type Page } from '@playwright/test';
import { browserFetch, requestForceSave } from './documents.ts';
import { type DocxInspection, inspectDocx } from './docx.ts';
import { pluginPanel } from './plugin.ts';

export interface NewPortion {
  marking: string;
  text: string;
}

// Places the cursor in the document and fills the panel's form, ready to
// insert.
export async function fillPortionForm(page: Page, portion: NewPortion): Promise<void> {
  const panel = pluginPanel(page);
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await panel.getByRole('radio', { name: portion.marking, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Portion text' }).fill(portion.text);
}

export async function insertPortion(page: Page, portion: NewPortion): Promise<void> {
  const panel = pluginPanel(page);
  const before = await panel.getByTestId('portion-item').count();
  await fillPortionForm(page, portion);
  await panel.getByRole('button', { name: 'Insert protected portion' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(before + 1);
}

export async function storedDocx(page: Page, documentId: string): Promise<DocxInspection> {
  const response = await browserFetch(page, `/documents/${documentId}/download`);
  expect(response.status).toBe(200);
  return inspectDocx(response.body);
}

// Force-saves until the stored file shows what the test waits for.
export async function forceSavedDocx(
  page: Page,
  documentId: string,
  isReady: (docx: DocxInspection) => boolean,
): Promise<DocxInspection> {
  let docx: DocxInspection | null = null;
  await expect
    .poll(
      async () => {
        await requestForceSave(page, documentId);
        docx = await storedDocx(page, documentId);
        return isReady(docx);
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe(true);
  if (docx === null) {
    throw new Error('No saved document');
  }
  return docx;
}
