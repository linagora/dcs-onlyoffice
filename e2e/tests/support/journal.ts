import { expect, type Locator, type Page } from '@playwright/test';

// The rows of the journal page, as the portal shows them with `filters`, that
// hold `text`. The journal stores an entry shortly after the action that
// caused it: the page is loaded again until the row shows.
export async function journalRow(page: Page, filters: Record<string, string>, text: string): Promise<Locator> {
  const row = page.getByRole('row').filter({ hasText: text });
  await expect
    .poll(async () => {
      await page.goto(`/admin/journal?${new URLSearchParams(filters).toString()}`);
      return row.count();
    })
    .toBeGreaterThan(0);
  return row;
}

// The fields of a journal row, by name, with the values the page shows as
// JSON read back: the journal keeps them as the database orders them.
export async function journalFields(row: Locator): Promise<Record<string, unknown>> {
  const lines = (await row.getByRole('cell').last().innerText()).split('\n');
  return Object.fromEntries(
    lines.map((line) => {
      const separator = line.indexOf(': ');
      const value = line.slice(separator + 2);
      return [line.slice(0, separator), value.startsWith('{') || value.startsWith('[') ? JSON.parse(value) : value];
    }),
  );
}
