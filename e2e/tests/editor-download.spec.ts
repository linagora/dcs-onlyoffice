import type { Page } from '@playwright/test';
import { editorPageConfig, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';

// Checks that the editor or viewer on the page offers no download of its own:
// that download comes from the Document Server, around the portal (#165).
// Printing stays, in the File menu.
async function expectNoEditorDownload(page: Page): Promise<void> {
  expect(await editorPageConfig(page)).toMatchObject({ document: { permissions: { download: false } } });
  const editor = page.frameLocator('iframe[name="frameEditor"]');
  await editor.getByText('File', { exact: true }).first().click();
  // The text editor's Print and the spreadsheet editor's, with its preview.
  await expect(editor.locator('[id^="fm-btn-print"]:visible')).toHaveText('Print');
  await expect(editor.locator('#fm-btn-download')).toBeHidden();
}

// A stored document leaves the platform through the portal's Download link
// only: the portal decides again who may take it, and has the policy service
// check the binding signature of the file that leaves.
for (const template of ['exercise-northwind.docx', 'exercise-northwind-logistics.xlsx']) {
  test(`the editor and the viewer of ${template} offer no download, and the portal's link gives the stored file`, async ({ page }) => {
    const documentId = await openNewDocument(page, template);
    await expectNoEditorDownload(page);

    await page.goto(`/documents/${documentId}/view`);
    await waitForEditorReady(page);
    await expectNoEditorDownload(page);

    await page.goto('/');
    const fileName = `${documentId}.${template.split('.').pop() ?? ''}`;
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: `Download ${fileName}`, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(fileName);
  });
}
