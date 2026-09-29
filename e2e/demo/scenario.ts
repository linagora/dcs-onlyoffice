import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BOB, BOB_TERMS, saveTerms, yesterday } from '../tests/support/clearances.ts';
import { dismissEditorTip, moveCursorToStart, openDocument, openedDocumentId, openNewDocument } from '../tests/support/documents.ts';
import { DOCX_TYPE, pageMarkingTexts } from '../tests/support/docx.ts';
import type { MarkedText } from '../tests/support/marker.ts';
import { bubble, pluginFrame, pluginPanel, selectParagraphs } from '../tests/support/plugin.ts';
import { insertPortion, leaveAndWaitForSave, storedDocx, storedFile } from '../tests/support/portions.ts';
import { demoCertificate, verifyBindingSignature } from '../tests/support/signature.ts';
import { fillUploadForm } from '../tests/support/uploads.ts';
import {
  cellValue,
  closePrintPreview,
  editorHeadersAndFooters,
  insertWorkbookPortion,
  openPrintPreview,
  openProtectionConfirmation,
  selectCells,
  SUPPLY_ROWS,
} from '../tests/support/workbooks.ts';
import { everySheetShows, inspectXlsx } from '../tests/support/xlsx.ts';

// The Word file of the demo generator that the example Microsoft 365 tenant
// labelled DIFFUSION RESTREINTE released to NATO.
const LABELLED_WORD_FILE = new URL('../../deploy/demo/uploads/fictional-report-labelled-in-microsoft-365.docx', import.meta.url);
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
// The uploaded report's paragraph on transport, by its position among the
// body's elements, and its text: content that went through ONLYOFFICE in
// clear, which the French officer protects.
const REPORT_TRANSPORT = { position: 6, text: 'Two fictional convoys a day link the rear base and the command posts.' };
// The demo SPIF's codes for DIFFUSION RESTREINTE released to NATO, and for
// SPECIAL FRANCE.
const RELEASABLE_TO_NATO_CODE = 'DEMO-FR:2/2.1';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
// Empty cells of the workbook template's sheet, where the portions go, wide
// and high enough for a placeholder to show its whole marking.
const FIRST_CELLS = 'F4:I5';
const SECOND_CELLS = 'F7:I8';
// The centre section of a workbook's headers and footers once a portion is
// more restrictive than its base label: bold, in the colour the demo SPIF
// gives DIFFUSION RESTREINTE.
const WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE = `&C&"-,Bold"&KE8590C${WITH_MORE_RESTRICTIVE_PORTIONS}`;

// The two people of the demo: the French officer, an administrator cleared
// for every label of the demo policy, and the allied officer, cleared for
// every label but SPECIAL FRANCE; both signed in, in browsers of their own.
export interface DemoPeople {
  alice: Page;
  bob: Page;
}

export interface DemoOptions {
  // Takes the screenshot of a step, for the walkthrough; nothing in the
  // replay.
  capture: (page: Page, name: string) => Promise<void>;
  // Takes the screenshot of the top of the editor's first page.
  captureTopOfPage: (page: Page, name: string) => Promise<void>;
  // A portion's fictional text.
  text: (words: string) => MarkedText;
}

// The demo scenario, step by step, as docs/walkthrough.md tells it: in a text
// document, then in a workbook. It checks each step's outcome, so that a
// broken demo fails.
export async function playDemo(people: DemoPeople, options: DemoOptions): Promise<void> {
  await playTextDocumentPart(people, options);
  await playWorkbookPart(people, options);
}

// Steps 1 to 11, in a text document. It gives the allied officer his
// clearance back, which it ends, whatever happens.
async function playTextDocumentPart({ alice, bob }: DemoPeople, options: DemoOptions): Promise<void> {
  const alicePanel = pluginPanel(alice);
  const aliceItem = (id: string) => portionItem(alice, id);
  const bobItem = (id: string) => portionItem(bob, id);
  const first = options.text('Fictional paragraph: the liaison officers join the control cell on day 1.');
  const second = options.text('Fictional paragraph: the logistics group reaches the rear base on day 2.');

  const documentId = await test.step('1. The French officer gives a new document its base label', async () => {
    const id = await openNewDocument(alice, 'exercise-northwind.docx');
    await dismissEditorTip(alice, 15_000);
    await alicePanel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
    await options.capture(alice, '01-base-label');
    return id;
  });

  const [firstId, secondId] = await test.step('2. She types two protected portions in the panel', async () => {
    await insertPortion(alice, { marking: DIFFUSION_RESTREINTE, text: first });
    await insertPortion(alice, { marking: DIFFUSION_RESTREINTE, text: second });
    const ids = [await portionIdOf(alice, first), await portionIdOf(alice, second)] as const;
    await expect(aliceItem(ids[0]).getByTestId('portion-text')).toHaveText(first);
    await expect(aliceItem(ids[1]).getByTestId('portion-text')).toHaveText(second);
    await options.capture(alice, '02-portions');
    return ids;
  });

  await test.step('3. The allied officer co-edits the document and reads both portions', async () => {
    await openDocument(bob, documentId);
    await dismissEditorTip(bob, 15_000);
    await expect(bobItem(firstId).getByTestId('portion-text')).toHaveText(first);
    await expect(bobItem(secondId).getByTestId('portion-text')).toHaveText(second);
    await options.capture(bob, '03-co-editing');
  });

  await test.step('4. The French officer changes the first portion, which the allied officer sees', async () => {
    await aliceItem(firstId).getByRole('button', { name: 'Change', exact: true }).click();
    const textbox = aliceItem(firstId).getByRole('textbox', { name: 'Portion text' });
    await expect(textbox).toHaveValue(first);
    await expect(bobItem(firstId).getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');
    const changed = options.text('Fictional paragraph, changed: the liaison officers join the control cell on day 2.');
    await textbox.fill(changed);
    await options.capture(bob, '04-being-changed');
    await aliceItem(firstId).getByRole('button', { name: 'Save the change' }).click();
    await expect(bobItem(firstId).getByTestId('portion-text')).toHaveText(changed);
    await expect(bobItem(firstId).getByTestId('portion-status')).toHaveCount(0);
  });

  await test.step('5. She raises it to SPECIAL FRANCE, which shuts the allied officer out', async () => {
    await aliceItem(firstId).getByRole('button', { name: 'Change', exact: true }).click();
    await expect(aliceItem(firstId).getByRole('textbox', { name: 'Portion text' })).toBeVisible();
    await aliceItem(firstId).getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
    await aliceItem(firstId).getByRole('button', { name: 'Save the change' }).click();
    await expect(bobItem(firstId).getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
    await expect(bobItem(firstId).getByTestId('portion-notice')).toHaveText('Access denied');
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
    await options.capture(bob, '05-access-denied');
  });

  await test.step('6. She deletes the second portion, which leaves both panels', async () => {
    await aliceItem(secondId).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(aliceItem(secondId).getByTestId('deletion-confirmation')).toBeVisible();
    await options.capture(alice, '06-deletion');
    await alicePanel.getByRole('button', { name: 'Delete the portion' }).click();
    await expect(aliceItem(secondId)).toHaveCount(0);
    await expect(bobItem(secondId)).toHaveCount(0);
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  });

  await test.step('7. The page marking follows the document label', async () => {
    await moveCursorToStart(alice);
    await options.captureTopOfPage(alice, '07-page-marking');
  });

  await test.step('8. The stored file carries the page marking and a binding that xmlsec1 verifies', async () => {
    await leaveAndWaitForSave([alice, bob], documentId, 1);
    // The save the portal forced when the base label changed may hold the
    // first portion alone, as it stood then: the session's last save holds it
    // SPECIAL FRANCE.
    await expect
      .poll(async () => (await storedDocx(alice, documentId)).portionParts.map((part) => part.label), { timeout: 90_000, intervals: [3_000] })
      .toEqual([SPECIAL_FRANCE_CODE]);
    const stored = await storedDocx(alice, documentId);
    expect(new Set(pageMarkingTexts(stored))).toEqual(new Set([WITH_MORE_RESTRICTIVE_PORTIONS]));
    const bindable = stored.bindableParts;
    expect(await verifyBindingSignature(await storedFile(alice, documentId), demoCertificate())).toEqual({ status: 0, manifest: `${bindable.length}/${bindable.length}` });
  });

  await test.step('9. The French officer ends the allied officer\'s clearance, and the document no longer opens for him', async () => {
    try {
      await saveTerms(alice, BOB, { ...BOB_TERMS, validThrough: yesterday() });
      await options.capture(alice, '09-revocation');
      const answer = await bob.goto(`/documents/${documentId}/edit`);
      expect(answer?.status()).toBe(403);
      await expect(bob.getByRole('heading', { name: 'Access denied' })).toBeVisible();
      await options.capture(bob, '09-refused');
    } finally {
      await saveTerms(alice, BOB, BOB_TERMS);
    }
  });

  await test.step('10. She uploads a Word file labelled in Microsoft 365, which gets the matching label', async () => {
    const file = { name: 'Fictional report labelled in Microsoft 365.docx', mimeType: DOCX_TYPE, buffer: await readFile(LABELLED_WORD_FILE) };
    await fillUploadForm(alice, file, 'carried');
    await alice.getByRole('button', { name: 'Upload' }).scrollIntoViewIfNeeded();
    await options.capture(alice, '10-upload');
    await alice.getByRole('button', { name: 'Upload' }).click();
    await openedDocumentId(alice);
    await expect(alicePanel.getByLabel('Base label')).toHaveValue(RELEASABLE_TO_NATO_CODE);
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);
    await options.capture(alice, '10-uploaded');
  });

  await test.step('11. She protects a paragraph of the report already written, for French eyes only', async () => {
    await selectParagraphs(await pluginFrame(alice), REPORT_TRANSPORT.position, REPORT_TRANSPORT.position);
    await alicePanel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
    await alicePanel.getByRole('button', { name: 'Protect the selection' }).click();
    const confirmation = alicePanel.getByTestId('protection-confirmation');
    await expect(confirmation.getByTestId('protection-preview')).toHaveText(REPORT_TRANSPORT.text);
    await options.capture(alice, '11-paragraph-protection');
    await confirmation.getByRole('button', { name: 'Protect the selection' }).click();
    await expect(alicePanel.getByTestId('portion-text')).toHaveText([REPORT_TRANSPORT.text]);
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(`${RELEASABLE_TO_NATO} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`);
  });
}

// Steps 12 to 20, in a workbook: the text document's steps from the base
// label to the signed binding, with the protection of rows already filled,
// the page marking showing in the print preview.
async function playWorkbookPart({ alice, bob }: DemoPeople, options: DemoOptions): Promise<void> {
  const alicePanel = pluginPanel(alice);
  const aliceItem = (id: string) => portionItem(alice, id);
  const bobItem = (id: string) => portionItem(bob, id);
  const first = options.text('Fictional stock: 1,200 rations reach the forward depot on day 1.');
  const second = options.text('Fictional convoy: the fuel trucks leave the rear base on day 2.');

  const documentId = await test.step('12. The French officer gives a new workbook its base label', async () => {
    const id = await openNewDocument(alice, WORKBOOK_TEMPLATE);
    await dismissEditorTip(alice, 15_000);
    await alicePanel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
    // The page's screen marking, above and below the editor.
    await expect(alice.getByTestId('screen-marking')).toHaveText([DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE]);
    await options.capture(alice, '12-workbook-base-label');
    return id;
  });

  const [firstId, secondId] = await test.step('13. She inserts two protected portions into cells', async () => {
    await insertWorkbookPortion(alice, { marking: DIFFUSION_RESTREINTE, text: first }, FIRST_CELLS);
    await insertWorkbookPortion(alice, { marking: DIFFUSION_RESTREINTE, text: second }, SECOND_CELLS);
    const ids = [await portionIdOf(alice, first), await portionIdOf(alice, second)] as const;
    await expect(aliceItem(ids[0]).getByTestId('portion-text')).toHaveText(first);
    await expect(aliceItem(ids[1]).getByTestId('portion-text')).toHaveText(second);
    // Away from the placeholders, which the bubble would cover.
    await selectCells(alice, 'B12');
    await options.capture(alice, '13-workbook-portions');
    return ids;
  });

  await test.step('14. The allied officer co-edits the workbook, and reads a portion over its placeholder', async () => {
    await openDocument(bob, documentId);
    await dismissEditorTip(bob, 15_000);
    await expect(bobItem(firstId).getByTestId('portion-text')).toHaveText(first);
    await expect(bobItem(secondId).getByTestId('portion-text')).toHaveText(second);
    for (const cell of ['F4', 'F7']) {
      await expect.poll(() => cellValue(bob, cell)).toBe(`${DIFFUSION_RESTREINTE} – protected portion`);
    }
    await selectCells(bob, FIRST_CELLS);
    await expect(bubble(bob).getByTestId('bubble-text')).toHaveText(first);
    await options.capture(bob, '14-workbook-co-editing');
  });

  await test.step('15. The French officer changes the first portion, which the allied officer sees', async () => {
    await aliceItem(firstId).getByRole('button', { name: 'Change', exact: true }).click();
    const textbox = aliceItem(firstId).getByRole('textbox', { name: 'Portion text' });
    await expect(textbox).toHaveValue(first);
    await expect(bobItem(firstId).getByTestId('portion-status')).toHaveText('Being changed by Alice Martin.');
    const changed = options.text('Fictional stock, changed: 1,500 rations reach the forward depot on day 1.');
    await textbox.fill(changed);
    await options.capture(bob, '15-workbook-being-changed');
    await aliceItem(firstId).getByRole('button', { name: 'Save the change' }).click();
    await expect(bobItem(firstId).getByTestId('portion-text')).toHaveText(changed);
    await expect(bobItem(firstId).getByTestId('portion-status')).toHaveCount(0);
  });

  await test.step('16. She raises it to SPECIAL FRANCE, which shuts the allied officer out', async () => {
    await aliceItem(firstId).getByRole('button', { name: 'Change', exact: true }).click();
    await expect(aliceItem(firstId).getByRole('textbox', { name: 'Portion text' })).toBeVisible();
    await aliceItem(firstId).getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
    await aliceItem(firstId).getByRole('button', { name: 'Save the change' }).click();
    await expect(bobItem(firstId).getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
    await expect(bobItem(firstId).getByTestId('portion-notice')).toHaveText('Access denied');
    await expect.poll(() => cellValue(bob, 'F4')).toBe(`${SPECIAL_FRANCE} – protected portion`);
    // The bubble he read the portion in closes.
    await expect(bubble(bob).owner()).toHaveCount(0);
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
    await expect(bob.getByTestId('screen-marking')).toHaveText([WITH_MORE_RESTRICTIVE_PORTIONS, WITH_MORE_RESTRICTIVE_PORTIONS]);
    await options.capture(bob, '16-workbook-access-denied');
  });

  await test.step('17. She deletes the second portion, whose cells empty', async () => {
    await aliceItem(secondId).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(aliceItem(secondId).getByTestId('deletion-confirmation')).toBeVisible();
    await options.capture(alice, '17-workbook-deletion');
    await alicePanel.getByRole('button', { name: 'Delete the portion' }).click();
    await expect(aliceItem(secondId)).toHaveCount(0);
    await expect(bobItem(secondId)).toHaveCount(0);
    await expect.poll(() => cellValue(bob, 'F7')).toBe('');
    await expect(alicePanel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  });

  const rowsId = await test.step('18. She protects two rows already filled for French eyes only, which the allied officer can no longer read', async () => {
    const confirmation = await openProtectionConfirmation(alice, SPECIAL_FRANCE, SUPPLY_ROWS.reference);
    await expect(confirmation.getByTestId('protection-preview')).toHaveText(SUPPLY_ROWS.text);
    await options.capture(alice, '18-workbook-protection');
    await confirmation.getByRole('button', { name: 'Protect the selection' }).click();
    const id = await portionIdOf(alice, 'Logistics group');
    await expect(aliceItem(id).getByTestId('portion-text')).toHaveText(SUPPLY_ROWS.text);
    await expect(bobItem(id).getByTestId('portion-notice')).toHaveText('Access denied');
    await expect.poll(() => cellValue(bob, 'A7')).toBe(`${SPECIAL_FRANCE} – protected portion`);
    // Away from the placeholder, whose bubble would stay over the print preview.
    await selectCells(alice, 'B12');
    return id;
  });

  await test.step('19. The page marking shows in the print preview', async () => {
    const header = `&LExercise NORTHWIND 26 - fictional${WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE}`;
    const footer = `${WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE}&RFictional workbook`;
    await expect
      .poll(() => editorHeadersAndFooters(alice))
      .toEqual([{ oddHeader: header, oddFooter: footer, evenHeader: header, evenFooter: footer, firstHeader: header, firstFooter: footer }]);
    await openPrintPreview(alice);
    await options.capture(alice, '19-workbook-print-preview');
    await closePrintPreview(alice);
  });

  await test.step('20. The stored workbook carries the page marking and a binding that xmlsec1 verifies', async () => {
    // The base label's save, made as the portions went in, held two portions too.
    await leaveAndWaitForSave([alice, bob], documentId, [firstId, rowsId]);
    const file = await storedFile(alice, documentId);
    const stored = await inspectXlsx(file);
    expect(everySheetShows(stored, WITH_MORE_RESTRICTIVE_PORTIONS_CENTRE)).toBe(true);
    expect(stored.allText).not.toContain('Logistics group');
    const bindable = stored.bindableParts;
    expect(await verifyBindingSignature(file, demoCertificate())).toEqual({ status: 0, manifest: `${bindable.length}/${bindable.length}` });
  });
}

// A portion's entry in a person's panel.
function portionItem(page: Page, id: string): Locator {
  return pluginPanel(page).locator(`[data-portion-id="${id}"]`);
}

// The id of the portion whose text a person's panel shows.
async function portionIdOf(page: Page, text: string): Promise<string> {
  const id = await pluginPanel(page).locator('[data-portion-id]').filter({ hasText: text }).first().getAttribute('data-portion-id');
  if (id === null) {
    throw new Error(`No portion of the panel holds ${text}`);
  }
  return id;
}
