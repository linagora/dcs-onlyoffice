import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { portalLog, portionJournal } from './support/deployment.ts';
import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { type MarkedText, markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx, portionPageAddress } from './support/portions.ts';
import { cellValue, firstPortionId, insertWorkbookPortion, restrictedWorkbook, typeIntoCell } from './support/workbooks.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const CELLS = 'F4:G4';

// A DIFFUSION RESTREINTE workbook in which the French officer inserted a
// portion, which the allied officer co-edits; the portion's id.
async function sharedWorkbookWithPortion(alice: Page, bob: Page, marking: string, text: MarkedText): Promise<{ documentId: string; portionId: string }> {
  const documentId = await restrictedWorkbook(alice);
  await insertWorkbookPortion(alice, { marking, text }, CELLS);
  const portionId = await firstPortionId(alice);
  await openDocument(bob, documentId);
  return { documentId, portionId };
}

test('a co-author changes a portion of a workbook, which its author sees being changed, then raises it beyond his clearance', async ({ page, browser }) => {
  const since = new Date();
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    const { documentId, portionId } = await sharedWorkbookWithPortion(page, bob, DIFFUSION_RESTREINTE, markedText('Fictional stock level before its change'));
    const bobItem = pluginPanel(bob).getByTestId('portion-item');
    const aliceItem = pluginPanel(page).getByTestId('portion-item');
    await expect(bobItem.getByTestId('portion-text')).toContainText('Fictional stock level before its change');

    await bobItem.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(aliceItem.getByTestId('portion-status')).toHaveText('Being changed by Bob Walker.');
    const changed = markedText('Fictional stock level after its change');
    await bobItem.getByRole('textbox', { name: 'Portion text' }).fill(changed);
    await bobItem.getByRole('button', { name: 'Save the change' }).click();

    await expect(aliceItem.getByTestId('portion-text')).toHaveText(changed);
    await expect(aliceItem.getByTestId('portion-status')).toHaveCount(0);

    await aliceItem.getByRole('button', { name: 'Change', exact: true }).click();
    await aliceItem.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
    await aliceItem.getByRole('button', { name: 'Save the change' }).click();

    await expect(bobItem.getByTestId('portion-marking')).toHaveText(SPECIAL_FRANCE);
    await expect(bobItem.getByTestId('portion-notice')).toHaveText('Access denied');
    await expect.poll(() => cellValue(bob, 'F4')).toBe(`${SPECIAL_FRANCE} – protected portion`);
    // Both editors lifted the placeholder's lock to write it, and got it
    // back: no one can type into it.
    for (const editor of [page, bob]) {
      await typeIntoCell(editor, 'F4', 'X');
      expect(await cellValue(editor, 'F4')).toBe(`${SPECIAL_FRANCE} – protected portion`);
    }
    const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts[0]?.version === '3');
    expect(saved.portionParts).toEqual([expect.objectContaining({ id: portionId, version: '3', label: SPECIAL_FRANCE_CODE, encoding: 'ztdf' })]);
    expect(saved.worksheets[0]?.userProtectedRanges).toEqual([{ name: portionId, reference: CELLS, users: [] }]);
    // Each change wrote the placeholder's link again, which stays one.
    expect(saved.worksheets[0]?.links).toEqual([{ reference: CELLS, target: portionPageAddress({ documentId, portionId }) }]);
    await expect
      .poll(() => portionJournal(since, 'Portion changed in the panel', portionId))
      .toEqual([
        expect.objectContaining({ documentId, user: 'bob', before: { label: DIFFUSION_RESTREINTE_CODE, version: 1 }, after: { label: DIFFUSION_RESTREINTE_CODE, version: 2 } }),
        expect.objectContaining({ documentId, user: 'alice', before: { label: DIFFUSION_RESTREINTE_CODE, version: 2 }, after: { label: SPECIAL_FRANCE_CODE, version: 3 } }),
      ]);
    expect(portalLog(since)).not.toContain(changed);
  } finally {
    await bob.context().close();
  }
});

test("an author refused a workbook portion's label is offered neither Change nor Delete", async ({ page, browser }) => {
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await sharedWorkbookWithPortion(page, bob, SPECIAL_FRANCE, markedText('Fictional convoy route under SPECIAL FRANCE'));
    const bobItem = pluginPanel(bob).getByTestId('portion-item');

    await expect(bobItem.getByTestId('portion-notice')).toHaveText('Access denied');
    await expect(bobItem.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
    await expect(bobItem.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(pluginPanel(page).getByTestId('portion-item').getByRole('button', { name: 'Change', exact: true })).toBeVisible();
  } finally {
    await bob.context().close();
  }
});

test('a co-author deletes a portion of a workbook, whose cells take a value again', async ({ page, browser }) => {
  const since = new Date();
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    const text = markedText('Fictional portion to delete');
    const { documentId, portionId } = await sharedWorkbookWithPortion(page, bob, DIFFUSION_RESTREINTE, text);
    const bobItem = pluginPanel(bob).getByTestId('portion-item');
    await expect(bobItem.getByTestId('portion-text')).toContainText('Fictional portion to delete');

    await bobItem.getByRole('button', { name: 'Delete', exact: true }).click();
    await pluginPanel(bob).getByRole('button', { name: 'Delete the portion' }).click();

    await expect(pluginPanel(bob).getByTestId('portion-item')).toHaveCount(0);
    await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(0);
    await expect.poll(() => cellValue(page, 'F4')).toBe('');
    for (const editor of [page, bob]) {
      await typeIntoCell(editor, 'F4', 'Z');
      await expect.poll(() => cellValue(editor, 'F4')).toBe('Z');
    }
    const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 0);
    expect(saved.worksheets[0]?.userProtectedRanges).toEqual([]);
    expect(saved.worksheets[0]?.mergedCells).toEqual([]);
    expect(saved.worksheets[0]?.links).toEqual([]);
    await expect
      .poll(() => portionJournal(since, 'Portion deleted in the panel', portionId))
      .toEqual([expect.objectContaining({ documentId, user: 'bob', before: { label: DIFFUSION_RESTREINTE_CODE, version: 1 } })]);
    expect(portalLog(since)).not.toContain(text);
  } finally {
    await bob.context().close();
  }
});
