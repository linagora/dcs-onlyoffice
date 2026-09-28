import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { pageMarkingTexts } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion } from './support/portions.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// Bob's clearance lets him read both labels; a portion released to NATO is
// more restrictive than a document that is not.
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;

// Undocumented behaviour 5: Custom XML parts written by one author reach the
// other authors of a co-editing session.
test('portions and the document label reach a co-author without reloading', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  await expect(pluginPanel(bob).getByTestId('identity-name')).toHaveText('Bob Walker');

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expect(pluginPanel(bob).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);

  const secret = markedText('Fictional shared portion');
  await insertPortion(page, { marking: RELEASABLE_TO_NATO, text: secret });
  await expect(pluginPanel(bob).getByTestId('portion-text')).toHaveText([secret]);
  await expect(pluginPanel(bob).getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  await bob.context().close();
});

test('portions inserted at the same moment by two authors are both kept, with the right document label and page marking', async ({
  page,
  browser,
}) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const alicePanel = pluginPanel(page);
  const bobPanel = pluginPanel(bob);
  await alicePanel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expect(bobPanel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);

  // Alice's portion is no more restrictive than the base label; Bob's is.
  const aliceText = markedText('Fictional portion by Alice');
  const bobText = markedText('Fictional portion by Bob');
  const drafts = [
    { author: page, panel: alicePanel, marking: DIFFUSION_RESTREINTE, text: aliceText, position: { x: 400, y: 300 } },
    { author: bob, panel: bobPanel, marking: RELEASABLE_TO_NATO, text: bobText, position: { x: 400, y: 420 } },
  ];
  for (const draft of drafts) {
    await draft.author.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: draft.position });
    await draft.panel.getByRole('radio', { name: draft.marking, exact: true }).check();
    await draft.panel.getByRole('textbox', { name: 'Portion text' }).fill(draft.text);
  }
  await Promise.all(drafts.map((draft) => draft.panel.getByRole('button', { name: 'Insert protected portion' }).click()));

  for (const panel of [alicePanel, bobPanel]) {
    await expect.poll(async () => (await panel.getByTestId('portion-text').allTextContents()).sort()).toEqual([aliceText, bobText].sort());
    await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  }
  const docx = await forceSavedDocx(
    page,
    documentId,
    (saved) =>
      saved.portionParts.length === 2 &&
      saved.bindings[0]?.label?.categories.some((category) => category.tagName === 'Composition') === true &&
      pageMarkingTexts(saved).every((text) => text === WITH_MORE_RESTRICTIVE_PORTIONS),
  );
  expect(docx.portionParts.map((part) => part.encoding)).toEqual(['ztdf', 'ztdf']);
  expect(docx.allText).not.toContain(aliceText);
  expect(docx.allText).not.toContain(bobText);
  expect(docx.contentControls).toHaveLength(2);
  expect(docx.bindings).toHaveLength(1);
  // One page marking in each of the six headers and footers: default, first
  // page and even pages.
  expect(pageMarkingTexts(docx)).toEqual(Array.from({ length: 6 }, () => WITH_MORE_RESTRICTIVE_PORTIONS));
  await bob.context().close();
});
