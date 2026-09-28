import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { portalLog, portalLogEntries } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { pageMarkingTexts, parsedTag } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { field } from './support/json.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, relabelPortionPart } from './support/plugin.ts';
import { documentWithPortion, forceSavedDocx, insertPortion, savedPortion } from './support/portions.ts';

const NON_PROTEGE = 'NON PROTÉGÉ';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
// The demo SPIF's codes for these labels, which the journal names.
const NON_PROTEGE_CODE = 'DEMO-FR:1';
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';

// The entries of the portal's journal about a portion since `since`, with
// the given message.
function journal(since: Date, message: string, portionId: string): unknown[] {
  return portalLogEntries(since).filter((entry) => field(entry, 'msg') === message && field(entry, 'portion') === portionId);
}

// Starts the change of the page's only portion, and gives the markings of
// the labels its form offers.
async function startChange(page: Page): Promise<string[]> {
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(item.getByRole('textbox', { name: 'Portion text' })).toBeVisible();
  return item.getByTestId('label-marking').allTextContents();
}

async function saveWithLabel(page: Page, marking: string): Promise<void> {
  const item = pluginPanel(page).getByTestId('portion-item');
  await item.getByRole('radio', { name: marking, exact: true }).check();
  await item.getByRole('button', { name: 'Save the change' }).click();
}

test('the French officer raises a portion to SPÉCIAL FRANCE, which the allied officer then cannot read', async ({ page, browser }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  await panel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  const text = markedText('Fictional paragraph raised to SPÉCIAL FRANCE');
  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text });
  const portion = await savedPortion(page, documentId);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const bobPortion = pluginPanel(bob).getByTestId('portion-item');
  await expect(bobPortion.getByTestId('portion-text')).toHaveText(text);

  await startChange(page);
  await saveWithLabel(page, SPECIAL_FRANCE);

  await expect(bobPortion.getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
  await expect(bobPortion.getByTestId('portion-notice')).toHaveText('Access denied');
  await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts[0]?.label === SPECIAL_FRANCE_CODE);
  expect(docx.portionParts.map((part) => part.version)).toEqual(['2']);
  expect(docx.contentControls.map((control) => ({ ...control, tag: parsedTag(control.tag) }))).toEqual([
    {
      alias: 'Protected portion',
      tag: { v: 1, id: portion.portionId, label: SPECIAL_FRANCE_CODE },
      lock: 'sdtContentLocked',
      text: `${SPECIAL_FRANCE} – protected portion`,
    },
  ]);
  expect(pageMarkingTexts(docx)).toEqual(Array.from({ length: 6 }, () => WITH_MORE_RESTRICTIVE_PORTIONS));
  await expect
    .poll(() => journal(since, 'Portion changed in the panel', portion.portionId))
    .toEqual([
      expect.objectContaining({
        documentId,
        user: 'alice',
        lowering: false,
        before: { label: DIFFUSION_RESTREINTE_CODE, version: 1 },
        after: { label: SPECIAL_FRANCE_CODE, version: 2 },
      }),
    ]);
  expect(portalLog(since)).not.toContain(text);
  await bob.context().close();
});

test('only an administrator cleared for a portion label is offered a lower one, and a lowering is logged as such', async ({ page, browser }) => {
  const since = new Date();
  const text = markedText('Fictional paragraph lowered by an administrator');
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text });
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, portion.documentId);
  expect(await startChange(bob)).toEqual([DIFFUSION_RESTREINTE, RELEASABLE_TO_NATO]);
  await pluginPanel(bob).getByTestId('portion-item').getByRole('button', { name: 'Cancel' }).click();
  await bob.context().close();

  expect(await startChange(page)).toEqual([NON_PROTEGE, DIFFUSION_RESTREINTE, SPECIAL_FRANCE, RELEASABLE_TO_NATO]);
  await saveWithLabel(page, NON_PROTEGE);

  await expect(pluginPanel(page).getByTestId('portion-item').getByTestId('portion-marking')).toHaveText(NON_PROTEGE);
  await expect
    .poll(() => journal(since, 'Portion label lowered in the panel', portion.portionId))
    .toEqual([
      expect.objectContaining({
        documentId: portion.documentId,
        user: 'alice',
        lowering: true,
        before: { label: DIFFUSION_RESTREINTE_CODE, version: 1 },
        after: { label: NON_PROTEGE_CODE, version: 2 },
      }),
    ]);
  expect(portalLog(since)).not.toContain(text);
});

test('a save that lowers a portion label outside the panel is logged with the users of its editing session', async ({ page }) => {
  const since = new Date();
  const portion = await documentWithPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph relabelled by hand') });

  await relabelPortionPart(await pluginFrame(page), portion.portionId, NON_PROTEGE_CODE);

  await forceSavedDocx(page, portion.documentId, (saved) => saved.portionParts[0]?.label === NON_PROTEGE_CODE);
  await expect
    .poll(() => journal(since, 'Portion label lowered', portion.portionId))
    .toEqual([
      expect.objectContaining({
        documentId: portion.documentId,
        before: { part: DIFFUSION_RESTREINTE_CODE, tag: DIFFUSION_RESTREINTE_CODE },
        after: { part: NON_PROTEGE_CODE, tag: DIFFUSION_RESTREINTE_CODE },
        sessionUsers: ['alice'],
      }),
    ]);
});
