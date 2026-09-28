import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { portalLog, portionJournal } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { pageMarkingTexts } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, removePortion } from './support/plugin.ts';
import { documentWithPortion, forceSavedDocx, insertPortion, savedPortion } from './support/portions.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
// The demo SPIF's codes for these labels, which the journal names.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';

// Asks to delete the page's only portion, which then awaits its confirmation.
async function startDeletion(page: Page): Promise<void> {
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(item.getByTestId('deletion-confirmation')).toBeVisible();
}

test('deleting the only SPÉCIAL FRANCE portion removes it from the file and lowers the document label and its page marking', async ({ page }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  await panel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  const text = markedText('Fictional paragraph deleted from the panel');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text });
  const portion = await savedPortion(page, documentId);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);

  await startDeletion(page);
  await panel.getByRole('button', { name: 'Delete the portion' }).click();

  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 0 && saved.bindings[0]?.label?.categories.length === 0);
  expect(docx.contentControls).toEqual([]);
  expect(pageMarkingTexts(docx)).toEqual(Array.from({ length: 6 }, () => DIFFUSION_RESTREINTE));
  await expect
    .poll(() => portionJournal(since, 'Portion deleted in the panel', portion.portionId))
    .toEqual([expect.objectContaining({ documentId, user: 'alice', before: { label: SPECIAL_FRANCE_CODE, version: 1 } })]);
  expect(portalLog(since)).not.toContain(text);
});

test('a portion whose deletion is cancelled stays, and a deleted one leaves a co-author’s panel without reloading', async ({ page, browser }) => {
  const text = markedText('Fictional paragraph deleted under a co-author’s eyes');
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text });
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  const bobPortions = pluginPanel(bob).getByTestId('portion-item');
  await expect(bobPortions.getByTestId('portion-text')).toHaveText(text);
  const item = pluginPanel(page).getByTestId('portion-item');

  await startDeletion(page);
  await item.getByRole('button', { name: 'Cancel' }).click();

  await expect(item.getByTestId('deletion-confirmation')).toHaveCount(0);
  await expect(item.getByTestId('portion-text')).toHaveText(text);

  await startDeletion(page);
  await item.getByRole('button', { name: 'Delete the portion' }).click();

  await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(0);
  await expect(bobPortions).toHaveCount(0);
  await bob.context().close();
});

test('a save that removes a portion outside the panel is logged with the users of its editing session', async ({ page }) => {
  const since = new Date();
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph removed by hand') });

  await removePortion(await pluginFrame(page), portion.portionId);

  await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts.length === 0);
  await expect
    .poll(() => portionJournal(since, 'Portion removed', portion.portionId))
    .toEqual([
      expect.objectContaining({
        documentId: portion.documentId,
        before: { part: DIFFUSION_RESTREINTE_CODE, tag: DIFFUSION_RESTREINTE_CODE },
        after: { part: null, tag: null },
        sessionUsers: ['alice'],
      }),
    ]);
  expect(portionJournal(since, 'Portion deleted in the panel', portion.portionId)).toEqual([]);
});
