import { openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { executeEditorMethod, pluginFrame, pluginPanel } from './support/plugin.ts';
import { insertPortion } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';

function portionIdOf(control: unknown): string | null {
  if (typeof control !== 'object' || control === null || !('Tag' in control) || typeof control.Tag !== 'string') {
    return null;
  }
  const tag: unknown = JSON.parse(control.Tag);
  return typeof tag === 'object' && tag !== null && 'id' in tag && typeof tag.id === 'string' ? tag.id : null;
}

test('a click on a portion in the panel selects its block in the document', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: `Fictional first portion ${Date.now()}` });
  await insertPortion(page, { marking: RELEASABLE_TO_NATO, text: `Fictional second portion ${Date.now()}` });
  const panel = pluginPanel(page);
  const frame = await pluginFrame(page);

  for (const index of [0, 1]) {
    const entry = panel.getByTestId('portion-item').nth(index);
    const portionId = await entry.getAttribute('data-portion-id');
    await entry.click();
    await expect
      .poll(async () => {
        const internalId = await executeEditorMethod(frame, 'GetCurrentContentControl', []);
        const controls = await executeEditorMethod(frame, 'GetAllContentControls', []);
        const current = Array.isArray(controls) ? controls.find((control) => control?.InternalId === internalId) : null;
        return portionIdOf(current);
      })
      .toBe(portionId);
  }
});

test('the panel highlights the portion whose block holds the cursor', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: `Fictional first portion ${Date.now()}` });
  await insertPortion(page, { marking: RELEASABLE_TO_NATO, text: `Fictional second portion ${Date.now()}` });
  const panel = pluginPanel(page);
  const frame = await pluginFrame(page);
  const controls = await executeEditorMethod(frame, 'GetAllContentControls', []);
  const blocks = Array.isArray(controls) ? controls : [];

  for (const block of blocks) {
    await executeEditorMethod(frame, 'MoveCursorToContentControl', [block.InternalId, true]);
    await expect(panel.locator('[data-testid="portion-item"][aria-current="true"]')).toHaveAttribute(
      'data-portion-id',
      portionIdOf(block) ?? 'missing',
    );
  }
});

test('the context menu offers to insert a protected portion', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  const editor = page.frameLocator('iframe[name="frameEditor"]');

  await editor.locator('#editor_sdk').click({ position: { x: 400, y: 300 }, button: 'right' });
  await editor.getByText('Insert protected portion', { exact: true }).click();

  await expect(pluginPanel(page).getByTestId('insertion-requested')).toBeVisible();
});

test('the toolbar offers to insert a protected portion', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  const editor = page.frameLocator('iframe[name="frameEditor"]');

  await editor.getByText('Insert', { exact: true }).first().click();
  // The toolbar breaks the caption over two lines.
  await editor.getByRole('button', { name: /^Protected\s*portion$/ }).click();

  await expect(pluginPanel(page).getByTestId('insertion-requested')).toBeVisible();
});
