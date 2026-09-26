import { openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion } from './support/portions.ts';

const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

// The demo scenario: a document releasable to allies that holds a portion
// restricted to French readers.
test('the document label follows its base label and portions, and is stored per ADatP-4778.2', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);

  await panel.getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  await expect(panel.getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: `Fictional French-only paragraph ${Date.now()}` });
  await expect(panel.getByTestId('document-label-marking')).toHaveText(
    `${RELEASABLE_TO_NATO} – CONTIENT DES PORTIONS PLUS RESTRICTIVES`,
  );

  const docx = await forceSavedDocx(page, documentId, (saved) =>
    saved.bindings.some((binding) => binding.label?.categories.some((category) => category.tagName === 'Composition')),
  );
  expect(docx.bindings).toHaveLength(1);
  expect(docx.bindings[0]?.label).toEqual({
    policy: 'DEMO-FR',
    classification: 'DIFFUSION RESTREINTE',
    categories: [
      { type: 'PERMISSIVE', tagName: 'Releasable To', values: ['NATO'] },
      { type: 'INFORMATIVE', tagName: 'Composition', values: ['MORE RESTRICTIVE PORTIONS'] },
    ],
  });
  expect(docx.bindableParts).toContain('word/header1.xml');
  expect([...(docx.bindings[0]?.references ?? [])].sort()).toEqual(docx.bindableParts.map((part) => `pack:///${part}`));
});
