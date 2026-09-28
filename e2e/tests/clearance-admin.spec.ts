import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { ALICE, ALICE_TERMS, CHLOE, CHLOE_TERMS, entryForm, saveTerms, shownTerms, yesterday } from './support/clearances.ts';
import { DOMAIN } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { insertPortion, leaveAndWaitForSave, shownPortions } from './support/portions.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// A write of alice's own terms: refused, it would change nothing either.
const HARMLESS_WRITE = {
  email: ALICE,
  policy: 'DEMO-FR',
  classification: ALICE_TERMS.classification,
  validFrom: ALICE_TERMS.validFrom,
  validThrough: ALICE_TERMS.validThrough,
};

test('the administration page lists every clearance of the directory', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Clearances' }).click();

  await expect(page.getByRole('heading', { name: 'Clearances' })).toBeVisible();
  const emails = ['alice.martin@dcs.test', 'bob.walker@dcs.test', 'chloe.bernard@dcs.test', 'erin.petit@dcs.test'];
  for (const email of emails) {
    await expect(entryForm(page, email)).toBeVisible();
  }
  const bob = page.getByRole('row').filter({ has: entryForm(page, 'bob.walker@dcs.test') });
  await expect(bob).toContainText('Bob Walker');
  await expect(bob).toContainText('GBR');
  expect(await shownTerms(page, 'bob.walker@dcs.test')).toEqual({
    classification: 'DIFFUSION RESTREINTE',
    categories: ['Releasable To:NATO'],
    validFrom: '2026-01-01',
    validThrough: '2035-12-31',
  });
});

// The Document Server's host is a sibling of the portal's: the browser sends
// the session cookie with a form it submits to the portal.
test('a write submitted from another host is refused, even with an administrator session @cross-browser', async ({ page }) => {
  await page.goto(`https://docs.${DOMAIN}/healthcheck`);
  const refused = page.waitForResponse((response) => response.url().endsWith('/admin/clearances') && response.request().method() === 'POST');
  await page.evaluate(
    ({ action, fields }) => {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
    },
    {
      action: `https://portail.${DOMAIN}/admin/clearances`,
      fields: HARMLESS_WRITE,
    },
  );

  expect((await refused).status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();
  await page.goto('/admin/clearances');
  expect(await shownTerms(page, ALICE)).toEqual(ALICE_TERMS);
});

test.describe('signed in as bob', () => {
  test.use({ account: DEMO_ACCOUNTS.bob });

  test('the page and its writes are reserved to administrators', async ({ page }) => {
    const pageAnswer = await page.goto('/admin/clearances');
    expect(pageAnswer?.status()).toBe(403);

    const statuses = await page.evaluate(async (fields) => {
      const write = await fetch('/admin/clearances', { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
      const relayed = await fetch('/api/policy/directory/clearances');
      return { write: write.status, relayed: relayed.status };
    }, HARMLESS_WRITE);
    expect(statuses).toEqual({ write: 403, relayed: 403 });
  });
});

// OpenTDF reads the directory at every key request; the panel keeps what it
// read until the document is reopened.
test('a revocation applies once the document is reopened, and so does its restoration', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = markedText('Fictional French-eyes-only paragraph');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  await leaveAndWaitForSave([page], documentId, 1);

  try {
    await saveTerms(page, ALICE, { ...ALICE_TERMS, categories: ['Releasable To:NATO'] });
    await openDocument(page, documentId);
    await expect.poll(() => shownPortions(page)).toEqual([{ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' }]);
  } finally {
    await saveTerms(page, ALICE, ALICE_TERMS);
  }
  await openDocument(page, documentId);
  await expect.poll(() => shownPortions(page)).toEqual([{ marking: SPECIAL_FRANCE, text: secret, notice: null }]);
});

test('an entry outside its validity period grants nothing', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const unprotected = markedText('Fictional public paragraph');
  await insertPortion(page, { marking: NON_PROTEGE, text: unprotected });
  await leaveAndWaitForSave([page], documentId, 1);

  try {
    await saveTerms(page, CHLOE, { ...CHLOE_TERMS, validThrough: yesterday() });
    const chloe = await signedInPage(browser, DEMO_ACCOUNTS.chloe);
    // Not even the document's base label, NON PROTÉGÉ: the document does not
    // open. OpenTDF's refusal is in access-decisions.spec.ts.
    const response = await chloe.goto(`/documents/${documentId}/edit`);
    expect(response?.status()).toBe(403);
    await expect(chloe.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await chloe.context().close();
  } finally {
    await saveTerms(page, CHLOE, CHLOE_TERMS);
  }
});
