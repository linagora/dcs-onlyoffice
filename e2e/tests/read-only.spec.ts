import { editorPageConfig, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { insertPortion, leaveAndWaitForSave } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// Undocumented behaviour 6: the plugin runs in read-only mode and can still
// read portion blocks and Custom XML parts.
test('a document opened read-only shows its portions in the panel', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional read-only paragraph ${Date.now()}`;
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  await leaveAndWaitForSave([page], documentId, 1);

  await page.getByRole('link', { name: `Read ${documentId}.docx` }).click();
  await waitForEditorReady(page);

  const config = await editorPageConfig(page);
  expect(config).toMatchObject({ editorConfig: { mode: 'view' }, document: { permissions: { edit: false } } });
  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-text')).toHaveText([secret]);
  await expect(panel.getByTestId('portion-marking')).toHaveText([SPECIAL_FRANCE]);
  await expect(panel.getByRole('button', { name: 'Insert protected portion' })).toHaveCount(0);
});
