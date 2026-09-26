import { expect, test } from './support/fixtures.ts';

test('a demo document opens in the ONLYOFFICE editor from the portal', async ({ page }) => {
  await page.getByRole('link', { name: 'exercise-northwind.docx' }).click();

  await expect(page.locator('body')).toHaveAttribute('data-document-ready', 'true', {
    timeout: 180_000,
  });
});
