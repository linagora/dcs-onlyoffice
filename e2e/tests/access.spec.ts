import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { insertPortion, leaveAndWaitForSave, shownPortions } from './support/portions.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const REWRAP = '/api/opentdf/kas.AccessService/Rewrap';

// Counts the key requests a reader's panel sends from now on.
function watchRewraps(reader: Page): () => number {
  let count = 0;
  reader.on('request', (request) => {
    if (new URL(request.url()).pathname === REWRAP) {
      count += 1;
    }
  });
  return () => count;
}

test('a portion is read only by the people whose clearance allows its label, as it is inserted and on reopening', async ({
  page,
  browser,
}) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  const chloe = await signedInPage(browser, DEMO_ACCOUNTS.chloe);
  const bobRewraps = watchRewraps(bob);
  for (const reader of [bob, chloe]) {
    await openDocument(reader, documentId);
  }
  const secret = `Fictional French-eyes-only paragraph ${Date.now()}`;

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });

  await expect(pluginPanel(page).getByTestId('portion-text')).toHaveText([secret]);
  const refused = [{ marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' }];
  for (const reader of [bob, chloe]) {
    await expect.poll(() => shownPortions(reader)).toEqual(refused);
    // A refusal is not a technical failure, which would be a warning.
    await expect(pluginPanel(reader).getByTestId('portion-notice')).not.toHaveClass(/warning/);
  }

  // A second portion makes the panels read the document again; the refusal
  // is kept rather than asked again.
  const unprotected = `Fictional public paragraph ${Date.now()}`;
  await insertPortion(page, { marking: NON_PROTEGE, text: unprotected });
  const readable = [...refused, { marking: NON_PROTEGE, text: unprotected, notice: null }];
  for (const reader of [bob, chloe]) {
    await expect.poll(() => shownPortions(reader)).toEqual(readable);
  }
  expect(bobRewraps()).toBe(2);

  await leaveAndWaitForSave([page, bob, chloe], documentId, 2);
  for (const reader of [bob, chloe]) {
    await openDocument(reader, documentId);
    await expect.poll(() => shownPortions(reader)).toEqual(readable);
    await reader.context().close();
  }
});

test('someone without a clearance is refused every protected portion', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const dan = await signedInPage(browser, DEMO_ACCOUNTS.dan);
  await openDocument(dan, documentId);

  await insertPortion(page, { marking: NON_PROTEGE, text: `Fictional public paragraph ${Date.now()}` });

  await expect.poll(() => shownPortions(dan)).toEqual([{ marking: NON_PROTEGE, text: null, notice: 'Access denied' }]);
  await dan.context().close();
});
