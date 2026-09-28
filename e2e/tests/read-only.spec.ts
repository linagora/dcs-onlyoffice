import { editorPageConfig, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { bubble, pluginPanel } from './support/plugin.ts';
import { insertPortion, leaveAndWaitForSave } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// Undocumented behaviour 6: the plugin runs in read-only mode and can still
// read portion blocks and Custom XML parts.
test('a document opened read-only shows its portions in the panel and next to the cursor', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = markedText('Fictional read-only paragraph');
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
  await expect(panel.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

  // The portion that holds the cursor also shows next to it.
  await panel.getByTestId('portion-item').getByRole('button').click();
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(secret);
});
