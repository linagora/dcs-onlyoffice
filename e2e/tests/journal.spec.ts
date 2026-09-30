import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import JSZip from 'jszip';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { today, tomorrow } from './support/clearances.ts';
import { asJournalRole, storeDocument } from './support/deployment.ts';
import { browserFetch, editorDisconnection, openDocument, openNewDocument } from './support/documents.ts';
import { DOCX_TYPE } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, removePortion } from './support/plugin.ts';
import { documentWithPortion, forceSavedDocx, storedFile } from './support/portions.ts';
import { uploadedDocumentId } from './support/uploads.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// The demo SPIF's code of DIFFUSION RESTREINTE.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
// A DOCX that the panel never labelled: the portal's template.
const TEMPLATE = new URL('../../deploy/demo/documents/exercise-northwind.docx', import.meta.url);

// The rows of the journal page, as the portal shows them with `filters`, that
// hold `text`. The journal stores an entry shortly after the action that
// caused it: the page is loaded again until the row shows.
async function journalRow(page: Page, filters: Record<string, string>, text: string): Promise<Locator> {
  const row = page.getByRole('row').filter({ hasText: text });
  await expect
    .poll(async () => {
      await page.goto(`/admin/journal?${new URLSearchParams(filters).toString()}`);
      return row.count();
    })
    .toBeGreaterThan(0);
  return row;
}

test('an administrator reads in the journal a base label changed in the panel, with the name and email address of who changed it', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  const administrator = await signedInPage(browser, DEMO_ACCOUNTS.alice);

  await administrator.getByRole('link', { name: 'Journal', exact: true }).click();
  await expect(administrator.getByRole('heading', { name: 'Journal' })).toBeVisible();

  const row = await journalRow(administrator, { document: documentId }, 'Base label changed in the panel');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Label change');
  await expect(row).toContainText(documentId);
  await expect(row).toContainText('Alice Martin');
  await expect(row).toContainText('alice.martin@dcs.test');
  await expect(row).toContainText(DIFFUSION_RESTREINTE_CODE);
  await administrator.context().close();
});

test("the role with which the portal keeps the journal reads entries, but can neither change, delete nor backdate them", async () => {
  expect(asJournalRole('SELECT count(*) >= 0 FROM journal.entries')).toEqual({ ok: true, output: 't' });
  for (const sql of [
    "UPDATE journal.entries SET message = 'Rewritten'",
    'DELETE FROM journal.entries',
    'TRUNCATE journal.entries',
    `INSERT INTO journal.entries (recorded_at, category, message, people, fields) VALUES ('2000-01-01', 'label', 'Backdated', '[]', '{}')`,
  ]) {
    const result = asJournalRole(sql);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('permission denied for table entries');
  }
});

test('an editing session that a raised base label ended goes into the journal, with the person it excluded', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: SPECIAL_FRANCE });
  await expect(editorDisconnection(bob)).toBeVisible();
  await bob.context().close();
  const administrator = await signedInPage(browser, DEMO_ACCOUNTS.alice);

  const row = await journalRow(administrator, { document: documentId, category: 'session' }, 'Ended an editing session that the base label excludes someone from');
  await expect(row).toContainText('Editing session');
  await expect(row).toContainText('Bob Walker');
  await expect(row).toContainText('bob.walker@dcs.test');
  await administrator.context().close();
});

test('a stored file that no longer matches its signature goes into the journal as an alert, with who downloaded it', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.signed === true);
  const zip = await JSZip.loadAsync(await storedFile(page, documentId));
  zip.file('docProps/app.xml', `${(await zip.file('docProps/app.xml')?.async('string')) ?? ''}<!-- changed outside the portal -->`);
  const changedId = `journal-check-${randomBytes(4).toString('hex')}`;
  await storeDocument(changedId, await zip.generateAsync({ type: 'uint8array' }));

  await storedFile(page, changedId);

  const row = await journalRow(page, { document: changedId, category: 'stored-file' }, 'Stored file no longer matches its signature');
  await expect(row).toContainText('Stored file alert');
  await expect(row).toContainText('docProps/app.xml');
  await expect(row).toContainText('Alice Martin');
  await expect(row).toContainText('alice.martin@dcs.test');
});

test('an upload goes into the journal, with the base label it got and who uploaded the file', async ({ page }) => {
  const documentId = await uploadedDocumentId(page, { name: 'Fictional journal report.docx', mimeType: DOCX_TYPE, buffer: await readFile(TEMPLATE) }, DIFFUSION_RESTREINTE_CODE);

  const row = await journalRow(page, { document: documentId, category: 'upload' }, 'Document uploaded');
  await expect(row).toContainText('Upload');
  await expect(row).toContainText(DIFFUSION_RESTREINTE_CODE);
  await expect(row).toContainText('Alice Martin');
  await expect(row).toContainText('alice.martin@dcs.test');
});

test('a save that removes a portion outside the panel goes into the journal, with the people of its editing session', async ({ page, browser }) => {
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph removed by hand before the journal') });

  await removePortion(await pluginFrame(page), portion.portionId);
  await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts.length === 0);
  const administrator = await signedInPage(browser, DEMO_ACCOUNTS.alice);

  const row = await journalRow(administrator, { document: portion.documentId, category: 'save' }, 'Portion removed');
  await expect(row).toContainText('Save');
  await expect(row).toContainText(portion.portionId);
  await expect(row).toContainText('Alice Martin');
  await expect(row).toContainText('alice.martin@dcs.test');
  await administrator.context().close();
});

test('the journal filters its entries by person, category and period, and pages through the older ones', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  // More entries than a page holds, as the panel reports them.
  for (let index = 0; index < 55; index += 1) {
    const reported = await browserFetch(page, `/documents/${documentId}/portion-deletion`, 'POST', {
      portion: `fictional-portion-${index}`,
      before: { label: DIFFUSION_RESTREINTE_CODE, version: 1 },
    });
    expect(reported.status).toBe(204);
  }
  const administrator = await signedInPage(browser, DEMO_ACCOUNTS.alice);
  const deletions = administrator.getByRole('row').filter({ hasText: 'Portion deleted in the panel' });

  await journalRow(administrator, { document: documentId }, 'fictional-portion-54');
  await expect(deletions).toHaveCount(50);
  await expect(deletions.first()).toContainText('fictional-portion-54');
  await administrator.getByRole('link', { name: 'Older entries' }).click();
  await expect(deletions).toHaveCount(5);
  await expect(deletions.last()).toContainText('fictional-portion-0');
  await expect(administrator.getByRole('link', { name: 'Older entries' })).toHaveCount(0);
  await administrator.getByRole('link', { name: 'Newest entries' }).click();
  await expect(deletions).toHaveCount(50);

  await administrator.goto(`/admin/journal?${new URLSearchParams({ document: documentId, person: 'bob.walker' }).toString()}`);
  await expect(deletions).toHaveCount(0);
  await administrator.goto(`/admin/journal?${new URLSearchParams({ document: documentId, person: 'alice.martin', category: 'label', from: today(), through: today() }).toString()}`);
  await expect(deletions).toHaveCount(50);
  await administrator.goto(`/admin/journal?${new URLSearchParams({ document: documentId, person: 'Alice Mar' }).toString()}`);
  await expect(deletions).toHaveCount(50);
  await administrator.goto(`/admin/journal?${new URLSearchParams({ document: documentId, category: 'upload' }).toString()}`);
  await expect(deletions).toHaveCount(0);
  await administrator.goto(`/admin/journal?${new URLSearchParams({ document: documentId, from: tomorrow() }).toString()}`);
  await expect(administrator.getByText('No entry.')).toBeVisible();
  await administrator.context().close();
});

test.describe('a person who is no administrator', () => {
  test.use({ account: DEMO_ACCOUNTS.bob });

  test('sees no link to the journal, and is refused its page', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Journal', exact: true })).toHaveCount(0);

    const refused = await page.goto('/admin/journal');

    expect(refused?.status()).toBe(403);
    await expect(page.getByText('This page is reserved to administrators.')).toBeVisible();
  });
});
