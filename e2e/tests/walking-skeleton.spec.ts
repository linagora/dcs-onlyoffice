import { waitForEditorReady } from './support/documents.ts';
import { test } from './support/fixtures.ts';

test('a demo document opens in the ONLYOFFICE editor from the portal', async ({ page }) => {
  await page.getByRole('link', { name: 'exercise-northwind.docx', exact: true }).click();

  await waitForEditorReady(page);
});
