import JSZip from 'jszip';
import { storeDocument } from './support/deployment.ts';
import { openNewDocument } from './support/documents.ts';
import { inspectDocx, sensitivityLabelProperties } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, storedFile } from './support/portions.ts';
import { demoCertificate, verifyBindingSignature } from './support/signature.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// The fictional tenant of the example label mapping (deploy/spif), and the
// sensitivity label it pairs with DIFFUSION RESTREINTE.
const DEMO_TENANT = '00000000-0000-0000-0000-000000000000';
const DIFFUSION_RESTREINTE_LABEL = '10000000-0000-4000-8000-000000000002';

test('a saved document carries the sensitivity label of its document label, which the binding signature covers', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });

  // The SPECIAL FRANCE portion leaves the sensitivity label at DIFFUSION
  // RESTREINTE: the mapping leaves out the document label's informative
  // category, MORE RESTRICTIVE PORTIONS.
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional paragraph under a sensitivity label') });
  const saved = await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 1 && docx.customProperties.length > 0);

  const { ActionId, SetDate, ...label } = sensitivityLabelProperties(saved, DIFFUSION_RESTREINTE_LABEL);
  expect(label).toEqual({ Enabled: 'true', Method: 'Privileged', Name: 'DCS-Diffusion-Restreinte-Standard', SiteId: DEMO_TENANT, ContentBits: '0' });
  expect(ActionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(SetDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(saved.customProperties.map((property) => [property.fmtid, property.type])).toEqual(
    Array.from({ length: 7 }, () => ['{D5CDD505-2E9C-101B-9397-08002B2CF9AE}', 'lpwstr']),
  );
  const stored = await storedFile(page, documentId);
  const bindable = (await inspectDocx(stored)).bindableParts;
  expect(bindable).toContain('docProps/custom.xml');
  expect(await verifyBindingSignature(stored, demoCertificate())).toEqual({ status: 0, manifest: `${bindable.length}/${bindable.length}` });
});

test('a sensitivity label keeps its date and its action id from one save to the next', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  const first = sensitivityLabelProperties(
    await forceSavedDocx(page, documentId, (docx) => docx.customProperties.length > 0),
    DIFFUSION_RESTREINTE_LABEL,
  );

  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph saved twice') });
  const second = sensitivityLabelProperties(
    await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 1),
    DIFFUSION_RESTREINTE_LABEL,
  );

  expect([second['SetDate'], second['ActionId']]).toEqual([first['SetDate'], first['ActionId']]);
});

test('a file stored without its sensitivity label gets it back at its next save', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (docx) => docx.customProperties.length > 0);
  // Someone with access to the portal's storage strips the custom properties.
  const zip = await JSZip.loadAsync(await storedFile(page, documentId));
  zip.file('docProps/custom.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>');
  await storeDocument(documentId, await zip.generateAsync({ type: 'uint8array' }));
  expect((await inspectDocx(await storedFile(page, documentId))).customProperties).toEqual([]);

  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph after the properties went') });
  const saved = await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 1);

  expect(sensitivityLabelProperties(saved, DIFFUSION_RESTREINTE_LABEL)).toMatchObject({ Enabled: 'true', Name: 'DCS-Diffusion-Restreinte-Standard', SiteId: DEMO_TENANT });
});
