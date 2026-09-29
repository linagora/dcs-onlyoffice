import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { browserFetch, openNewDocument, requestForceSave } from './documents.ts';
import { type DocxInspection, inspectDocx, type PackageInspection } from './docx.ts';
import type { MarkedText } from './marker.ts';
import { pluginPanel } from './plugin.ts';
import { inspectXlsx, type XlsxInspection } from './xlsx.ts';

export interface NewPortion {
  marking: string;
  text: MarkedText;
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

export interface ShownPortion {
  marking: string;
  text: string | null;
  notice: string | null;
}

// What a reader's panel shows of each portion, by marking: the text, or the
// notice that stands in for it. Portions inserted at the same place keep no
// predictable order.
export async function shownPortions(reader: Page): Promise<ShownPortion[]> {
  // One snapshot of the list: it re-renders while envelopes are opened.
  const shown = await pluginPanel(reader)
    .getByTestId('portion-item')
    .evaluateAll((items) =>
      items.map((item) => {
        const textOf = (testId: string): string | null => item.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.innerText ?? null;
        return { marking: textOf('portion-marking') ?? '', text: textOf('portion-text'), notice: textOf('portion-notice') };
      }),
    );
  return shown.sort((left, right) => left.marking.localeCompare(right.marking));
}

// A document's stored file, as its download gives it.
export async function storedFile(page: Page, documentId: string): Promise<Buffer> {
  const response = await browserFetch(page, `/documents/${documentId}/download`);
  expect(response.status).toBe(200);
  return response.body;
}

export async function storedDocx(page: Page, documentId: string): Promise<DocxInspection> {
  return inspectDocx(await storedFile(page, documentId));
}

// What the stored file of a text document or of a workbook holds.
async function storedPackage(page: Page, documentId: string): Promise<PackageInspection> {
  const file = await storedFile(page, documentId);
  const zip = await JSZip.loadAsync(file);
  return zip.file('xl/workbook.xml') === null ? inspectDocx(file) : inspectXlsx(file);
}

// Leaves the editor on every page that has the document open, then waits for
// the Document Server to store it, which it does once the last editor has
// left, with the number of portions the test expects.
export async function leaveAndWaitForSave(editors: Page[], documentId: string, portionCount: number): Promise<void> {
  const [first] = editors;
  if (first === undefined) {
    throw new Error('No editor to leave');
  }
  // Fast co-editing sends changes asynchronously; let them reach the server.
  await first.waitForTimeout(2_000);
  for (const editor of editors) {
    await editor.goto('/');
  }
  await expect
    .poll(async () => (await storedPackage(first, documentId)).portionParts.length, { timeout: 90_000, intervals: [3_000] })
    .toBe(portionCount);
}

// Force-saves until the stored file shows what the test waits for.
export async function forceSavedDocx(page: Page, documentId: string, isReady: (docx: DocxInspection) => boolean): Promise<DocxInspection> {
  return forceSaved(page, documentId, inspectDocx, isReady);
}

// Force-saves a workbook until its stored file shows what the test waits for.
export async function forceSavedXlsx(page: Page, documentId: string, isReady: (xlsx: XlsxInspection) => boolean): Promise<XlsxInspection> {
  return forceSaved(page, documentId, inspectXlsx, isReady);
}

async function forceSaved<T>(page: Page, documentId: string, inspect: (file: Buffer) => Promise<T>, isReady: (inspected: T) => boolean): Promise<T> {
  let inspected: T | null = null;
  await expect
    .poll(
      async () => {
        await requestForceSave(page, documentId);
        inspected = await inspect(await storedFile(page, documentId));
        return isReady(inspected);
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe(true);
  if (inspected === null) {
    throw new Error('No saved document');
  }
  return inspected;
}

// A portion as its document's saved file holds it: the code of its label and
// its envelope.
export interface SavedPortion {
  documentId: string;
  portionId: string;
  labelCode: string;
  envelope: string;
}

// Force-saves a document that holds one portion until its file holds it too.
export async function savedPortion(page: Page, documentId: string): Promise<SavedPortion> {
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 1);
  const part = docx.portionParts[0];
  if (part?.id === null || part?.id === undefined || part.label === null) {
    throw new Error('The saved DOCX holds no labelled portion part');
  }
  return { documentId, portionId: part.id, labelCode: part.label, envelope: part.content };
}

// A new document with one portion, as stored.
export async function documentWithPortion(page: Page, portion: NewPortion): Promise<SavedPortion> {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, portion);
  return savedPortion(page, documentId);
}
