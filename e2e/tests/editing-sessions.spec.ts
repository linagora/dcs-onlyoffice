import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { BOB, BOB_TERMS, type Terms, today, withTerms, yesterday } from './support/clearances.ts';
import { deploymentSetting, withValidUntilInDirectory } from './support/deployment.ts';
import {
  earlierEditorEvents,
  editorDisconnection as disconnection,
  editorDocumentKey,
  editorPageConfig,
  openDocument,
  openNewDocument,
  openWithEarlierConfig,
} from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { journalRow } from './support/journal.ts';
import { pluginPanel } from './support/plugin.ts';
import { storedDocx } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// The demo SPIF's code of DIFFUSION RESTREINTE – DIFFUSION OTAN.
const RELEASABLE_TO_NATO_CODE = 'DEMO-FR:2/2.1';
// Longer than the portal takes to end a session after a revocation.
const REVOCATION_APPLIED_MS = 5_000;
// How long after the test sets it a clearance expires.
const EXPIRY_DELAY_MS = 5_000;

// A signed editor configuration joins its document's editing session
// whenever it connects. When the base label comes to exclude someone who
// holds one, the session ends, so that the document moves to a new key that
// the configuration does not name.
for (const { kind, template } of [
  { kind: 'text document', template: 'exercise-northwind.docx' },
  { kind: 'workbook', template: 'exercise-northwind-logistics.xlsx' },
]) {
  test(`a base label that excludes someone holding an editor configuration ends the editing session of a ${kind}`, async ({ page, browser }) => {
    const documentId = await openNewDocument(page, template);
    const key = await editorDocumentKey(page);
    const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
    await openDocument(bob, documentId);
    const bobConfig = await editorPageConfig(bob);

    await pluginPanel(page).getByLabel('Base label').selectOption({ label: SPECIAL_FRANCE });

    await expect(disconnection(bob)).toBeVisible();
    await expect(disconnection(page)).toBeVisible();
    await openDocument(page, documentId);
    expect(await editorDocumentKey(page)).not.toBe(key);

    // bob's earlier configuration names a key whose version was saved: the
    // Document Server asks for a new configuration, which the portal no
    // longer signs for him, and opens nothing.
    await openWithEarlierConfig(bob, bobConfig);
    await expect.poll(() => earlierEditorEvents(bob)).toEqual(['onRequestRefreshFile']);
    // Nor does the document open later.
    await bob.waitForTimeout(3_000);
    expect(await earlierEditorEvents(bob)).toEqual(['onRequestRefreshFile']);
    await bob.context().close();
  });
}

// Whoever joins a session is decided again: a clearance changed outside the
// administration page since the configuration was signed, which the portal
// learns of only at its next periodic check, no longer lets its holder in.
test('someone whose clearance no longer allows the document does not get back into its session with a configuration signed earlier', async ({
  page,
  browser,
}) => {
  // alice keeps the document's editing session open.
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const bobConfig = await editorPageConfig(bob);
  await bob.goto('/');

  // Its last valid day becomes yesterday.
  await withValidUntilInDirectory(BOB, `${today()}T00:00:00Z`, async () => {
    await openWithEarlierConfig(bob, bobConfig);
    // The portal disconnects him as he joins, unless its periodic check
    // ended the session first: the Document Server then asks for a new
    // configuration, which the portal no longer signs for him.
    await expect
      .poll(async () => (await disconnection(bob).isVisible()) || (await earlierEditorEvents(bob)).includes('onRequestRefreshFile'))
      .toBe(true);
    if (await disconnection(bob).isVisible()) {
      // The decision made as he joined disconnected him, not a later check.
      // alice, an administrator, reads the journal.
      await journalRow(page, { document: documentId, category: 'session' }, 'Disconnected editors whom the base label excludes from an editing session');
    }
  });
  await bob.context().close();
});

// Every few seconds for the tests, every minute by default, the portal checks
// the clearances of the people who hold a configuration of an editing
// session: an expiry, or a change made in the clearance directory itself,
// ends the sessions it excludes them from within that interval.
test('a clearance that expires during an editing session ends it within the interval of the periodic check, and the journal says so', async ({
  page,
  browser,
}) => {
  const interval = Number(deploymentSetting('CLEARANCE_CHECK_SECONDS'));
  expect(interval, 'the stack runs with CLEARANCE_CHECK_SECONDS=10, as deploy/.env.example sets it').toBeLessThanOrEqual(15);
  const intervalMs = interval * 1_000;
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);

  // In the clearance directory itself, which the portal learns nothing from.
  await withValidUntilInDirectory(BOB, new Date(Date.now() + EXPIRY_DELAY_MS).toISOString(), async () => {
    await expect(disconnection(bob)).toBeVisible({ timeout: EXPIRY_DELAY_MS + intervalMs + REVOCATION_APPLIED_MS });
    await expect(disconnection(page)).toBeVisible();
    // alice, an administrator, then reads the journal.
    const row = await journalRow(page, { document: documentId, category: 'session' }, 'Ended an editing session that a revocation excludes someone from');
    await expect(row).toContainText('Bob Walker <bob.walker@dcs.test> (excluded)');
  });
  await bob.context().close();
});

// A revocation made on the administration page applies at once: the portal
// ends the editing sessions of the documents that the new clearance no longer
// lets its holder open, as when a base label is raised, and every co-author
// opens the document again.
const REVOCATIONS: { change: string; terms: Terms }[] = [
  { change: 'lowering a classification', terms: { ...BOB_TERMS, classification: 'NON PROTEGE' } },
  { change: 'removing a category', terms: { ...BOB_TERMS, categories: [] } },
  { change: 'setting the last valid day to yesterday', terms: { ...BOB_TERMS, validThrough: yesterday() } },
];
for (const { change, terms } of REVOCATIONS) {
  test(`${change} on the administration page ends at once the editing session of a document its holder may no longer open, and the journal says so`, async ({
    page,
    browser,
  }) => {
    const documentId = await openNewDocument(page, 'exercise-northwind.docx');
    await pluginPanel(page).getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
    // The panel has the portal save the document at once; the portal decides
    // from the stored base label.
    await expect.poll(async () => (await storedDocx(page, documentId)).baseLabel, { intervals: [1_000] }).toBe(RELEASABLE_TO_NATO_CODE);
    const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
    await openDocument(bob, documentId);

    await withTerms(browser, BOB, terms, BOB_TERMS, async () => {
      await expect(disconnection(bob)).toBeVisible();
      await expect(disconnection(page)).toBeVisible();
      // alice, an administrator, then reads the journal.
      const row = await journalRow(page, { document: documentId, category: 'session' }, 'Ended an editing session that a revocation excludes someone from');
      await expect(row).toContainText('Bob Walker <bob.walker@dcs.test> (excluded)');
    });
    await bob.context().close();
  });
}

test('a clearance change that lets its holder read more ends no editing session', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);

  await withTerms(browser, BOB, { ...BOB_TERMS, categories: [...BOB_TERMS.categories, 'Special Handling:SPECIAL FRANCE'] }, BOB_TERMS, async () => {
    await bob.waitForTimeout(REVOCATION_APPLIED_MS);
    await expect(disconnection(bob)).toBeHidden();
    await expect(disconnection(page)).toBeHidden();
    // alice, an administrator, then reads the journal.
    await page.goto(`/admin/journal?${new URLSearchParams({ document: documentId, category: 'session' }).toString()}`);
    await expect(page.getByText('No entry.')).toBeVisible();
  });
  await bob.context().close();
});
