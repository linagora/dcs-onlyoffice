import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion } from './support/portions.ts';

const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// Undocumented behaviour 5: Custom XML parts written by one author reach the
// other authors of a co-editing session.
test('portions and the document label reach a co-author without reloading', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  await expect(pluginPanel(bob).getByTestId('identity-name')).toHaveText('Bob Walker');

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  await expect(pluginPanel(bob).getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);

  const secret = `Fictional shared portion ${Date.now()}`;
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  await expect(pluginPanel(bob).getByTestId('portion-text')).toHaveText([secret]);
  await expect(pluginPanel(bob).getByTestId('document-label-marking')).toHaveText(
    `${RELEASABLE_TO_NATO} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`,
  );
  await bob.context().close();
});

test('portions inserted at the same moment by two authors are both kept, with the right document label', async ({
  page,
  browser,
}) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const alicePanel = pluginPanel(page);
  const bobPanel = pluginPanel(bob);
  await alicePanel.getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  await expect(bobPanel.getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);

  // Alice's portion is no more restrictive than the base label; Bob's is.
  const aliceText = `Fictional portion by Alice ${Date.now()}`;
  const bobText = `Fictional portion by Bob ${Date.now()}`;
  const drafts = [
    { author: page, panel: alicePanel, marking: RELEASABLE_TO_NATO, text: aliceText, position: { x: 400, y: 300 } },
    { author: bob, panel: bobPanel, marking: SPECIAL_FRANCE, text: bobText, position: { x: 400, y: 420 } },
  ];
  for (const draft of drafts) {
    await draft.author.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: draft.position });
    await draft.panel.getByRole('radio', { name: draft.marking, exact: true }).check();
    await draft.panel.getByRole('textbox', { name: 'Portion text' }).fill(draft.text);
  }
  await Promise.all(drafts.map((draft) => draft.panel.getByRole('button', { name: 'Insert protected portion' }).click()));

  const expectedLabel = `${RELEASABLE_TO_NATO} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
  for (const panel of [alicePanel, bobPanel]) {
    await expect.poll(async () => (await panel.getByTestId('portion-text').allTextContents()).sort()).toEqual([aliceText, bobText].sort());
    await expect(panel.getByTestId('document-label-marking')).toHaveText(expectedLabel);
  }
  const docx = await forceSavedDocx(
    page,
    documentId,
    (saved) =>
      saved.portionParts.length === 2 &&
      saved.bindings[0]?.label?.categories.some((category) => category.tagName === 'Composition') === true,
  );
  expect(docx.portionParts.map((part) => part.encoding)).toEqual(['ztdf', 'ztdf']);
  expect(docx.allText).not.toContain(aliceText);
  expect(docx.allText).not.toContain(bobText);
  expect(docx.contentControls).toHaveLength(2);
  expect(docx.bindings).toHaveLength(1);
  await bob.context().close();
});
