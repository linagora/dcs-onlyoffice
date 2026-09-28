import type { Locator, Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { BOB, BOB_TERMS, saveTerms, yesterday } from './support/clearances.ts';
import { earlierEditorEvents, editorDocumentKey, editorPageConfig, openDocument, openNewDocument, openWithEarlierConfig } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// What ONLYOFFICE Docs tells an editor that the portal disconnects.
function disconnection(page: Page): Locator {
  return page.frameLocator('iframe[name="frameEditor"]').getByText('The file cannot be accessed right now.');
}

// A signed editor configuration joins its document's editing session
// whenever it connects. When the base label comes to exclude someone who
// holds one, the session ends, so that the document moves to a new key that
// the configuration does not name.
test('a base label that excludes someone holding an editor configuration ends the editing session', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
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
  // Document Server asks for a new configuration, which the portal no longer
  // signs for him, and opens nothing.
  await openWithEarlierConfig(bob, bobConfig);
  await expect.poll(() => earlierEditorEvents(bob)).toEqual(['onRequestRefreshFile']);
  // Nor does the document open later.
  await bob.waitForTimeout(3_000);
  expect(await earlierEditorEvents(bob)).toEqual(['onRequestRefreshFile']);
  await bob.context().close();
});

// Whoever joins a session is decided again: a clearance revoked since the
// configuration was signed no longer lets its holder in.
test('someone whose clearance no longer allows the document is disconnected when they join its session', async ({ page, browser }) => {
  // alice keeps the document's editing session open.
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const bobConfig = await editorPageConfig(bob);
  await bob.goto('/');
  const administrator = await signedInPage(browser, DEMO_ACCOUNTS.alice);

  try {
    await saveTerms(administrator, BOB, { ...BOB_TERMS, validThrough: yesterday() });
    await openWithEarlierConfig(bob, bobConfig);
    await expect(disconnection(bob)).toBeVisible();
  } finally {
    await saveTerms(administrator, BOB, BOB_TERMS);
    await administrator.context().close();
    await bob.context().close();
  }
});
