import type { Browser, Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { ALICE, ALICE_TERMS, CHLOE, CHLOE_TERMS, entryForm, saveTerms, shownTerms, withTerms, yesterday } from './support/clearances.ts';
import { DOMAIN } from './support/deployment.ts';
import { openDocument, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { bubble, pluginPanel } from './support/plugin.ts';
import { documentWithPortion, insertPortion, leaveAndWaitForSave, shownPortions } from './support/portions.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// Alice's clearance without SPÉCIAL FRANCE, and without anything above NON
// PROTÉGÉ.
const ALICE_WITHOUT_SPECIAL_FRANCE = { ...ALICE_TERMS, categories: ['Releasable To:NATO'] };
const ALICE_NON_PROTEGE = { ...ALICE_TERMS, classification: 'NON PROTEGE', categories: [] };
// How long the panel may take to apply a revocation: a few of the three-second
// intervals at which it rereads the portion locks, and learns with them which
// labels its person may read.
const PANEL_REACTION_MS = 10_000;
// How long a co-author's panel may take to see a released lock: two of those
// intervals, well within the 20-second lease after which the lock would lapse
// anyway.
const LOCK_RELEASE_SEEN_MS = 6_000;

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

// Types a portion's text at SPÉCIAL FRANCE, then takes SPÉCIAL FRANCE out of
// the author's clearance: the panel erases the text and says why, in the
// editor's language.
async function expectErasureAtRevocation(page: Page, browser: Browser, texts: { textbox: string; message: string }): Promise<void> {
  const panel = pluginPanel(page);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByLabel(texts.textbox).fill(markedText('Fictional text typed before a revocation'));

  await withTerms(browser, ALICE, ALICE_WITHOUT_SPECIAL_FRANCE, ALICE_TERMS, async () => {
    await expect(panel.getByLabel(texts.textbox)).toHaveValue('', { timeout: PANEL_REACTION_MS });
    await expect(panel.getByTestId('insertion-failure')).toHaveText(texts.message);
    await expect(panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true })).toHaveCount(0);
  });
}

// OpenTDF reads the directory at every key request, and the panel learns
// every few seconds, with the portion locks, which labels its person may
// still read: it forgets at once what a revocation no longer lets them read,
// and reads it again only once the document is reopened.
test('a revocation applies at once in the panel and the bubble, and its restoration once the document is reopened', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = markedText('Fictional French-eyes-only paragraph');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  await pluginPanel(page).getByTestId('portion-item').getByRole('button').click();
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(secret);
  const denied = [{ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' }];

  await withTerms(browser, ALICE, ALICE_WITHOUT_SPECIAL_FRANCE, ALICE_TERMS, async () => {
    await expect.poll(() => shownPortions(page), { timeout: PANEL_REACTION_MS }).toEqual(denied);
    await expect(bubble(page).owner()).toHaveCount(0);
  });
  // As long as the panel may take to learn of a change.
  await page.waitForTimeout(PANEL_REACTION_MS);
  expect(await shownPortions(page)).toEqual(denied);
  await openDocument(page, documentId);
  await expect.poll(() => shownPortions(page)).toEqual([{ marking: SPECIAL_FRANCE, text: secret, notice: null }]);
});

test('a revocation erases the text typed in the panel at a label its holder may no longer read, and says why', async ({ page, browser }) => {
  await openNewDocument(page, 'exercise-northwind.docx');

  await expectErasureAtRevocation(page, browser, {
    textbox: 'Portion text',
    message: 'Your clearance no longer allows this label: what you typed at it was erased.',
  });
});

test('with the editor in French, the panel says in French why a revocation erased the text typed', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  // As in localization.spec.ts, the address reopens the document in French
  // for this session only.
  await page.goto(`/documents/${documentId}/edit?lang=fr`);
  await waitForEditorReady(page);

  await expectErasureAtRevocation(page, browser, {
    textbox: 'Texte de la portion',
    message: 'Votre habilitation ne permet plus cette étiquette : ce que vous y aviez tapé a été effacé.',
  });
});

test("a revocation drops the change of a portion its holder may no longer read, and releases the portion's lock at once", async ({ page, browser }) => {
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph being changed at a revocation') });
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  const bobPortion = pluginPanel(bob).getByTestId('portion-item');
  const alicePortion = pluginPanel(page).getByTestId('portion-item');
  await alicePortion.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(bobPortion.getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');

  await withTerms(browser, ALICE, ALICE_NON_PROTEGE, ALICE_TERMS, async () => {
    await expect(alicePortion.getByTestId('portion-status')).toHaveText(
      'Your clearance no longer allows this portion’s label: the change or the deletion was dropped, and the portion’s lock released.',
      { timeout: PANEL_REACTION_MS },
    );
    await expect(bobPortion.getByRole('button', { name: 'Change', exact: true })).toBeVisible({ timeout: LOCK_RELEASE_SEEN_MS });
    await expect(alicePortion.getByTestId('portion-notice')).toHaveText('Access denied');
  });
  await bob.context().close();
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
