import { expect, test } from '@playwright/test';

test('a demo document opens in the ONLYOFFICE editor from the portal', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'exercise-northwind.docx' }).click();

  await expect(page.locator('body')).toHaveAttribute('data-document-ready', 'true', {
    timeout: 180_000,
  });
});
