import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { bubble, highlightedPortion, pluginPanel, watchBubbleOpenings } from './support/plugin.ts';
import { forceSavedXlsx } from './support/portions.ts';
import { activeCell, firstPortionId, insertWorkbookPortion, restrictedWorkbook, selectCells } from './support/workbooks.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// A placeholder of two merged cells, the cell under it, and a cell away from
// it.
const CELLS = 'F4:G4';
const BELOW = 'F5';
const AWAY = 'H10';

test('the selection highlights the portion whose placeholder holds it and opens the bubble, which leaving the placeholder or Escape closes', async ({ page }) => {
  await restrictedWorkbook(page);
  const text = markedText('Fictional ammunition count, held in cells');
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text }, CELLS);
  const portionId = await firstPortionId(page);

  await selectCells(page, AWAY);
  await expect(highlightedPortion(page)).toHaveCount(0);
  await expect(bubble(page).owner()).toHaveCount(0);

  // A cell of the placeholder, even the second of the merged ones.
  await selectCells(page, 'G4');
  await expect(highlightedPortion(page)).toHaveAttribute('data-portion-id', portionId);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);

  await selectCells(page, AWAY);
  await expect(highlightedPortion(page)).toHaveCount(0);
  await expect(bubble(page).owner()).toHaveCount(0);

  // An arrow key moves the selection into the placeholder as well.
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 200, y: 200 } });
  await selectCells(page, BELOW);
  await page.keyboard.press('ArrowUp');
  await expect(highlightedPortion(page)).toHaveAttribute('data-portion-id', portionId);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);

  await page.keyboard.press('Escape');
  await expect(bubble(page).owner()).toHaveCount(0);

  // Once closed, the bubble opens again on the next selection in the
  // placeholder.
  await selectCells(page, 'G4');
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);
});

// The panel rereads the workbook every 3 seconds through an editor command.
test('the bubble stays open while the selection stays in the placeholder, and closed once Escape closes it', async ({ page }) => {
  await restrictedWorkbook(page);
  const text = markedText('Fictional fuel count shown without a blink');
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text }, CELLS);
  const openings = watchBubbleOpenings(page);
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 200, y: 200 } });
  await selectCells(page, AWAY);
  await selectCells(page, 'G4');
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);
  const opened = openings.length;
  expect(opened).toBeGreaterThan(0);

  // Two rereads of the workbook.
  await page.waitForTimeout(7_000);

  expect(openings).toHaveLength(opened);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);

  await page.keyboard.press('Escape');
  await expect(bubble(page).owner()).toHaveCount(0);
  await page.waitForTimeout(7_000);
  await expect(bubble(page).owner()).toHaveCount(0);
  expect(openings).toHaveLength(opened);
});

test('a click on a portion in the panel selects its placeholder', async ({ page }) => {
  await restrictedWorkbook(page);
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional convoy order, held in cells') }, CELLS);
  await selectCells(page, AWAY);
  await expect.poll(() => activeCell(page)).toBe(AWAY);

  await pluginPanel(page).getByTestId('portion-item').locator('button.portion-select').click();

  await expect.poll(() => activeCell(page)).toBe('F4');
});

test('in the read-only viewer, the selection highlights the portion and opens the bubble, and a click in the panel selects its placeholder', async ({ page }) => {
  const documentId = await restrictedWorkbook(page);
  const text = markedText('Fictional supply count, read in the viewer');
  await insertWorkbookPortion(page, { marking: DIFFUSION_RESTREINTE, text }, CELLS);
  const portionId = await firstPortionId(page);
  await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 1);

  await page.goto(`/documents/${documentId}/view`);
  await waitForEditorReady(page);
  await expect(pluginPanel(page).getByTestId('portion-text')).toHaveText([text]);

  await selectCells(page, 'G4');
  await expect(highlightedPortion(page)).toHaveAttribute('data-portion-id', portionId);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(text);

  await selectCells(page, AWAY);
  await expect(highlightedPortion(page)).toHaveCount(0);
  await expect(bubble(page).owner()).toHaveCount(0);

  await pluginPanel(page).getByTestId('portion-item').locator('button.portion-select').click();
  await expect.poll(() => activeCell(page)).toBe('F4');
});

test("the allied officer's bubble does not open on a SPECIAL FRANCE placeholder", async ({ page, browser }) => {
  const documentId = await restrictedWorkbook(page);
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional route under SPECIAL FRANCE') }, CELLS);
  const portionId = await firstPortionId(page);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expect(pluginPanel(bob).getByTestId('portion-notice')).toHaveText('Access denied');

    await selectCells(bob, 'F4');

    await expect(highlightedPortion(bob)).toHaveAttribute('data-portion-id', portionId);
    // Long enough for the bubble to have opened, had it any text to show.
    await bob.waitForTimeout(3_000);
    await expect(bubble(bob).owner()).toHaveCount(0);
  } finally {
    await bob.context().close();
  }
});
