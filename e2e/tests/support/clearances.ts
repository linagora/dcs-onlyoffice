import { expect, type Locator, type Page } from '@playwright/test';

// What the administration page edits of an entry: its validity period as its
// first and last days.
export interface Terms {
  classification: string;
  categories: string[];
  validFrom: string;
  validThrough: string;
}

// The demo seed's entries (deploy/directory/seeds/demo.json), which every test
// that changes one restores.
export const ALICE = 'alice.martin@dcs.test';
export const ALICE_TERMS: Terms = {
  classification: 'DIFFUSION RESTREINTE',
  categories: ['Special Handling:SPECIAL FRANCE', 'Releasable To:NATO'],
  validFrom: '2026-01-01',
  validThrough: '2035-12-31',
};
export const BOB = 'bob.walker@dcs.test';
export const BOB_TERMS: Terms = {
  classification: 'DIFFUSION RESTREINTE',
  categories: ['Releasable To:NATO'],
  validFrom: '2026-01-01',
  validThrough: '2035-12-31',
};
export const CHLOE = 'chloe.bernard@dcs.test';
export const CHLOE_TERMS: Terms = { classification: 'NON PROTEGE', categories: [], validFrom: '2026-01-01', validThrough: '2035-12-31' };

export function entryForm(page: Page, email: string): Locator {
  return page.getByRole('form', { name: `Clearance of ${email}` });
}

export async function shownTerms(page: Page, email: string): Promise<Terms> {
  const form = entryForm(page, email);
  const categories: string[] = [];
  for (const checkbox of await form.getByRole('checkbox').all()) {
    if (await checkbox.isChecked()) {
      categories.push((await checkbox.getAttribute('value')) ?? '');
    }
  }
  return {
    classification: await form.getByLabel('Highest classification').inputValue(),
    categories,
    validFrom: await form.getByLabel('Valid from').inputValue(),
    validThrough: await form.getByLabel('Valid through').inputValue(),
  };
}

// Saves an entry's terms through the administration page, as an administrator.
export async function saveTerms(page: Page, email: string, terms: Terms): Promise<void> {
  await page.goto('/admin/clearances');
  const form = entryForm(page, email);
  await form.getByLabel('Highest classification').selectOption(terms.classification);
  for (const checkbox of await form.getByRole('checkbox').all()) {
    await checkbox.setChecked(terms.categories.includes((await checkbox.getAttribute('value')) ?? ''));
  }
  await form.getByLabel('Valid from').fill(terms.validFrom);
  await form.getByLabel('Valid through').fill(terms.validThrough);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText(`Clearance of ${email} saved.`);
}

// A last valid day that has passed: an entry that ends on it grants nothing.
export function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The current day and the next, UTC, as the portal's date fields take them.
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function tomorrow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
