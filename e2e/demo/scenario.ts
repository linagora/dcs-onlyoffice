import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { BOB, BOB_TERMS, saveTerms, yesterday } from '../tests/support/clearances.ts';
import { dismissEditorTip, moveCursorToStart, openDocument, openedDocumentId, openNewDocument } from '../tests/support/documents.ts';
import { DOCX_TYPE, pageMarkingTexts } from '../tests/support/docx.ts';
import type { MarkedText } from '../tests/support/marker.ts';
import { pluginPanel } from '../tests/support/plugin.ts';
import { insertPortion, leaveAndWaitForSave, storedDocx, storedFile } from '../tests/support/portions.ts';
import { demoCertificate, verifyBindingSignature } from '../tests/support/signature.ts';
import { fillUploadForm } from '../tests/support/uploads.ts';

// The Word file of the demo generator that the example Microsoft 365 tenant
// labelled DIFFUSION RESTREINTE released to NATO.
const LABELLED_WORD_FILE = new URL('../../deploy/demo/uploads/fictional-report-labelled-in-microsoft-365.docx', import.meta.url);
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const WITH_MORE_RESTRICTIVE_PORTIONS = `${DIFFUSION_RESTREINTE} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`;
// The demo SPIF's code for DIFFUSION RESTREINTE released to NATO.
const RELEASABLE_TO_NATO_CODE = 'DEMO-FR:2/2.1';

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

// The demo scenario, step by step, as docs/walkthrough.md tells it. It checks
// each step's outcome, so that a broken demo fails. It gives the allied
// officer his clearance back, which it ends, whatever happens.
export async function playDemo({ alice, bob }: DemoPeople, options: DemoOptions): Promise<void> {
  const alicePanel = pluginPanel(alice);
  const aliceItem = (id: string) => alicePanel.locator(`[data-portion-id="${id}"]`);
  const bobItem = (id: string) => pluginPanel(bob).locator(`[data-portion-id="${id}"]`);
  const idOf = async (text: string): Promise<string> => {
    const id = await alicePanel.locator('[data-portion-id]').filter({ hasText: text }).first().getAttribute('data-portion-id');
    if (id === null) {
      throw new Error(`No portion of the panel holds ${text}`);
    }
    return id;
  };
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
    const ids = [await idOf(first), await idOf(second)] as const;
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
}
