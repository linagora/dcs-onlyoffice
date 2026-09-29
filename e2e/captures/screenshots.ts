import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { dismissEditorTip } from '../tests/support/documents.ts';

// Saves what the page shows, once the editor has finished drawing.
export async function capture(page: Page, path: string): Promise<void> {
  await dismissEditorTip(page, 1_000);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path });
}

// Saves the top of the editor's drawing area: the first page's header, which
// the page marking opens.
export async function captureTopOfPage(page: Page, path: string): Promise<void> {
  const area = await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').boundingBox();
  if (area === null) {
    throw new Error('The editor has no drawing area');
  }
  await page.waitForTimeout(1_000);
  await page.screenshot({ path, clip: { x: area.x, y: area.y, width: area.width, height: Math.min(area.height, 300) } });
}

// Where a screenshot of a folder goes.
export function screenshotPath(directory: URL, name: string): string {
  return fileURLToPath(new URL(`${name}.png`, directory));
}
