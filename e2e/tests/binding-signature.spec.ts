import { documentLogEntries } from './support/deployment.ts';
import { browserFetch, openNewDocument } from './support/documents.ts';
import { BINDING_NAMESPACE } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { stringField } from './support/json.ts';
import { markedText } from './support/marker.ts';
import { pluginFrame, pluginPanel, replaceCustomXmlParts } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, storedFile } from './support/portions.ts';
import { demoCertificate, verifyBindingSignature } from './support/signature.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';

test('each save signs the document label binding, which xmlsec1 verifies against the demo certificate', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional paragraph under a signed binding') });

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 1 && saved.bindings[0]?.signed === true);

  // The label the base label and the portion give.
  expect(docx.bindings[0]?.label).toEqual({
    policy: 'DEMO-FR',
    classification: DIFFUSION_RESTREINTE,
    categories: [{ type: 'INFORMATIVE', tagName: 'Composition', values: ['MORE RESTRICTIVE PORTIONS'] }],
  });
  const parts = docx.bindableParts.length;
  expect(await verifyBindingSignature(await storedFile(page, documentId), demoCertificate())).toEqual({
    status: 0,
    manifest: `${parts}/${parts}`,
  });
});

test('a document label written in the file by hand is replaced at the next save, which the portal logs', async ({ page }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.label?.classification === DIFFUSION_RESTREINTE);
  // A binding labelled NON PROTÉGÉ, as the policy service would compute it
  // for a document whose base label is NON PROTÉGÉ.
  const computed = await browserFetch(page, '/api/policy/policies/DEMO-FR/document-label', 'POST', { base: 'DEMO-FR:1', portions: [] });
  const binding = stringField(JSON.parse(computed.body.toString('utf8')), 'xml');
  if (binding === null) {
    throw new Error('The policy service gave no binding');
  }

  await replaceCustomXmlParts(await pluginFrame(page), BINDING_NAMESPACE, binding);

  // The editor keeps the hand-written label: each save replaces it again.
  const replacements = (): unknown[] => documentLogEntries(since, 'Document label replaced at save', documentId);
  await expect
    .poll(async () => {
      await browserFetch(page, `/documents/${documentId}/forcesave`, 'POST');
      return replacements().length;
    })
    .toBeGreaterThan(0);
  expect(replacements()[0]).toMatchObject({ before: 'DEMO-FR:1', after: 'DEMO-FR:2' });
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.signed === true);
  expect(docx.bindings[0]?.label?.classification).toBe(DIFFUSION_RESTREINTE);
  const parts = docx.bindableParts.length;
  expect(await verifyBindingSignature(await storedFile(page, documentId), demoCertificate())).toEqual({
    status: 0,
    manifest: `${parts}/${parts}`,
  });
});
