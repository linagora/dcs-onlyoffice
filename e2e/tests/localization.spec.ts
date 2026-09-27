import { openNewDocument, waitForEditorReady } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// French captions are longer: at the default width, the toolbar drops the
// captions of its last buttons, the panel's among them.
test.use({ viewport: { width: 1920, height: 1080 } });

test('with the editor in French, the panel, the Insert tab button and new portions are in French', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  // The suite runs with the portal's default language, English; the address
  // reopens the document in French for this session only.
  await page.goto(`/documents/${documentId}/edit?lang=fr`);
  await waitForEditorReady(page);
  const panel = pluginPanel(page);
  const editor = page.frameLocator('iframe[name="frameEditor"]');

  await expect(panel.getByRole('heading')).toHaveText(['Étiquette du document', 'Nouvelle portion protégée', 'Portions protégées']);
  await expect(panel.getByLabel('Étiquette de base')).toBeVisible();
  await expect(panel.getByText('Aucune portion protégée pour l’instant.')).toBeVisible();

  await editor.getByText('Insertion', { exact: true }).first().click();
  // The toolbar breaks the caption over two lines.
  await editor.getByRole('button', { name: /^Portion\s*protégée$/ }).click();
  await expect(panel.getByTestId('insertion-requested')).toHaveText(
    'Choisissez une étiquette et saisissez le texte. La portion sera insérée après le paragraphe où se trouve le curseur.',
  );

  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Texte de la portion' }).fill(`Fictional French portion ${Date.now()}`);
  await panel.getByRole('button', { name: 'Insérer la portion protégée' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.contentControls.length === 1);
  expect(docx.contentControls).toEqual([
    { alias: 'Portion protégée', tag: expect.any(String), lock: 'sdtContentLocked', text: `${SPECIAL_FRANCE} – portion protégée` },
  ]);
});
