import { expect, test } from '@playwright/test';
import {
  editorDocumentKey,
  openDocument,
  openNewDocument,
  readDocumentText,
  requestForceSave,
  storedDocumentText,
  typeInDocument,
} from './support/documents.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('a forced save stores the edits while the editor stays open', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const marker = `forced-save-${Date.now()}`;
  await typeInDocument(page, `${marker} `);

  await expect
    .poll(
      async () => {
        await requestForceSave(page, documentId);
        return storedDocumentText(page, documentId);
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toContain(marker);
});

test('closing the editor saves the document, which reopens with the edits under a new key', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const firstKey = await editorDocumentKey(page);
  const marker = `session-end-${Date.now()}`;
  await typeInDocument(page, `${marker} `);
  // Fast co-editing sends keystrokes asynchronously; let them reach the server.
  await page.waitForTimeout(2_000);

  await page.goto('/');
  await expect
    .poll(async () => storedDocumentText(page, documentId), { timeout: 90_000, intervals: [3_000] })
    .toContain(marker);

  await openDocument(page, documentId);
  expect(await editorDocumentKey(page)).not.toBe(firstKey);
  expect(await readDocumentText(page)).toContain(marker);
});
