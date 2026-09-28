import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { bubble, pluginPanel } from './support/plugin.ts';
import { insertPortion } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// Puts the document's cursor in the document's only portion with the
// keyboard: a click where insertPortion clicked lands in the paragraph the
// portion follows, or in the portion itself.
async function moveCursorIntoPortion(page: Page): Promise<void> {
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  const portion = pluginPanel(page).getByTestId('portion-item');
  for (let presses = 0; presses < 10; presses += 1) {
    await page.waitForTimeout(500);
    if ((await portion.getAttribute('aria-current')) === 'true') {
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error('The cursor never reached the portion');
}

// Undocumented behaviour 7: a plugin window opened with `isTargeted` and
// `isCustomWindow` sits next to the cursor, leaves the keyboard to the
// document, and the editor tells the plugin of keys pressed in it.
test('the portion that holds the cursor is shown next to it, to its readers only', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = markedText('Fictional paragraph shown next to the cursor');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });

  // Selecting the portion from the panel puts the document's cursor in it.
  await pluginPanel(page).getByTestId('portion-item').getByRole('button').click();
  await expect(bubble(page).getByTestId('bubble-marking')).toHaveText(SPECIAL_FRANCE);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(secret);

  // The document keeps the keyboard: entering the portion opens the window,
  // leaving it closes the window, coming back opens it again, and Escape
  // closes it.
  await moveCursorIntoPortion(page);
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(secret);
  await page.keyboard.press('ArrowDown');
  await expect(bubble(page).owner()).toHaveCount(0);
  await page.keyboard.press('ArrowUp');
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(secret);
  await page.keyboard.press('Escape');
  await expect(bubble(page).owner()).toHaveCount(0);

  // bob's clearance does not allow SPECIAL FRANCE: his panel sees the cursor
  // in the portion, and opens no window.
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, documentId);
  const bobPortion = pluginPanel(bob).getByTestId('portion-item');
  await expect(bobPortion.getByTestId('portion-notice')).toHaveText('Access denied');
  await bobPortion.getByRole('button').click();
  await expect(bobPortion).toHaveAttribute('aria-current', 'true');
  await bob.waitForTimeout(3_000);
  await expect(bubble(bob).owner()).toHaveCount(0);
  await bob.context().close();
});
