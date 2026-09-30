import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { documentLogEntries, portalLog } from './support/deployment.ts';
import { editorPageConfig, openDocument, openedDocumentId, openNewDocument } from './support/documents.ts';
import { BINDING_NAMESPACE, DOCX_TYPE, LABEL_NAMESPACE, sensitivityLabelProperties } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, forceSavedXlsx, insertPortion, shownPortions, storedDocx, storedFile } from './support/portions.ts';
import { demoAuthorityCertificate, verifyBindingSignature } from './support/signature.ts';
import { upload, type UploadedFile, withCustomXmlPart, withLabelMetadata, wordLabelElement, wordLabelProperties } from './support/uploads.ts';
import { insertWorkbookPortion } from './support/workbooks.ts';
import { inspectXlsx, XLSX_TYPE } from './support/xlsx.ts';

const TEMPLATE = new URL('../../deploy/demo/documents/exercise-northwind.docx', import.meta.url);
// The demo generator's workbook that the example tenant labelled DIFFUSION
// RESTREINTE released to NATO, in custom properties and a Sensitivity Label
// Information part.
const LABELLED_WORKBOOK = new URL('../../deploy/demo/uploads/fictional-workbook-labelled-in-microsoft-365.xlsx', import.meta.url);
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const NON_PROTEGE = 'NON PROTÉGÉ';
// The demo SPIF's codes for these labels, which the journal names.
const CODES = { nato: 'DEMO-FR:2/2.1', specialFrance: 'DEMO-FR:2/1.1', diffusionRestreinte: 'DEMO-FR:2', nonProtege: 'DEMO-FR:1' } as const;
const DEMO_POLICY_URI = 'urn:oid:2.25.166231019600111174217682845337071458325';
// The example label mapping's fictional tenant (deploy/spif), the sensitivity
// label it pairs with DIFFUSION RESTREINTE released to NATO, and another
// tenant.
const DEMO_TENANT = '00000000-0000-0000-0000-000000000000';
const NATO_SENSITIVITY_LABEL = '10000000-0000-4000-8000-000000000003';
const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';

// The template labelled by another tool: an ADatP-4778 binding of a
// DIFFUSION RESTREINTE document label, unsigned, under the given policy, and
// no base label part of the platform's.
async function labelledByAnotherTool(policy = 'DEMO-FR', policyUri = DEMO_POLICY_URI): Promise<UploadedFile> {
  const label =
    `<slab:originatorConfidentialityLabel xmlns:slab="${LABEL_NAMESPACE}"><slab:ConfidentialityInformation>` +
    `<slab:PolicyIdentifier URI="${policyUri}">${policy}</slab:PolicyIdentifier><slab:Classification>DIFFUSION RESTREINTE</slab:Classification>` +
    '</slab:ConfidentialityInformation></slab:originatorConfidentialityLabel>';
  const binding =
    `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"><mb:MetadataBindingContainer><mb:MetadataBinding Id="mb-document">` +
    `<mb:Metadata>${label}</mb:Metadata><mb:DataReference URI="pack:///word/document.xml"/>` +
    '</mb:MetadataBinding></mb:MetadataBindingContainer></mb:BindingInformation>';
  return { name: 'Fictional labelled report.docx', mimeType: DOCX_TYPE, buffer: await withCustomXmlPart(await readFile(TEMPLATE), binding, BINDING_NAMESPACE) };
}

// What the journal holds of an upload, apart from the fields every entry has.
function uploadEntry(fields: Record<string, unknown>): unknown {
  return expect.objectContaining({ ...fields, time: expect.any(Number) });
}

test('a document downloaded from the portal and uploaded again keeps its base label and its portions', async ({ page, browser }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  const frenchOnly = markedText('Fictional French-only paragraph uploaded again');
  const releasable = markedText('Fictional releasable paragraph uploaded again');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: frenchOnly });
  await insertPortion(page, { marking: RELEASABLE_TO_NATO, text: releasable });
  await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 2 && docx.bindings[0]?.label?.categories.some((category) => category.tagName === 'Composition') === true);
  const downloaded = await storedFile(page, documentId);

  expect(await upload(page, { name: 'Fictional exercise report.docx', mimeType: DOCX_TYPE, buffer: downloaded }, 'carried')).toBe(303);

  const uploadedId = await openedDocumentId(page);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.nato);
  await expect
    .poll(() => shownPortions(page))
    .toEqual([
      { marking: RELEASABLE_TO_NATO, text: releasable, notice: null },
      { marking: SPECIAL_FRANCE, text: frenchOnly, notice: null },
    ]);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, uploadedId);
  await expect
    .poll(() => shownPortions(bob))
    .toEqual([
      { marking: RELEASABLE_TO_NATO, text: releasable, notice: null },
      { marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' },
    ]);
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', uploadedId))
    .toEqual([uploadEntry({ base: CODES.nato, read: { code: CODES.nato, source: 'base-label' }, signature: 'matched', lowering: false, user: 'alice' })]);
});

test('a workbook downloaded from the portal and uploaded again keeps its base label and its portions', async ({ page, browser }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind-logistics.xlsx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(RELEASABLE_TO_NATO);
  const frenchOnly = markedText('Fictional French-only count uploaded again');
  const releasable = markedText('Fictional releasable count uploaded again');
  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: frenchOnly }, 'F4:G4');
  await insertWorkbookPortion(page, { marking: RELEASABLE_TO_NATO, text: releasable }, 'F6:G6');
  await forceSavedXlsx(page, documentId, (xlsx) => xlsx.portionParts.length === 2 && xlsx.bindings[0]?.label?.categories.some((category) => category.tagName === 'Composition') === true);
  const downloaded = await storedFile(page, documentId);

  expect(await upload(page, { name: 'Fictional exercise logistics.xlsx', mimeType: XLSX_TYPE, buffer: downloaded }, 'carried')).toBe(303);

  const uploadedId = await openedDocumentId(page);
  await expect(page).toHaveTitle('Fictional exercise logistics.xlsx');
  expect((await editorPageConfig(page)).documentType).toBe('cell');
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.nato);
  await expect
    .poll(() => shownPortions(page))
    .toEqual([
      { marking: RELEASABLE_TO_NATO, text: releasable, notice: null },
      { marking: SPECIAL_FRANCE, text: frenchOnly, notice: null },
    ]);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  await openDocument(bob, uploadedId);
  await expect
    .poll(() => shownPortions(bob))
    .toEqual([
      { marking: RELEASABLE_TO_NATO, text: releasable, notice: null },
      { marking: SPECIAL_FRANCE, text: null, notice: 'Access denied' },
    ]);
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', uploadedId))
    .toEqual([uploadEntry({ base: CODES.nato, read: { code: CODES.nato, source: 'base-label' }, signature: 'matched', lowering: false, user: 'alice' })]);
  expect(portalLog(since)).not.toContain(frenchOnly);
  expect(portalLog(since)).not.toContain(releasable);
  await bob.context().close();
});

// Whatever its name says, the file's main part decides its format, whose
// extension the document's name then takes.
test('a workbook named as a text document is stored and named as a workbook', async ({ page }) => {
  const buffer = await readFile(LABELLED_WORKBOOK);

  expect(await upload(page, { name: 'Fictional workbook named as a report.docx', mimeType: DOCX_TYPE, buffer }, 'carried')).toBe(303);

  await openedDocumentId(page);
  await expect(page).toHaveTitle('Fictional workbook named as a report.xlsx');
  expect((await editorPageConfig(page)).documentType).toBe('cell');
});

test('a workbook that a Microsoft 365 tenant labelled gets the label the mapping pairs with it, and opens in the spreadsheet editor', async ({ page }) => {
  const since = new Date();

  const buffer = await readFile(LABELLED_WORKBOOK);
  expect(await upload(page, { name: 'Fictional logistics workbook.xlsx', mimeType: XLSX_TYPE, buffer }, 'carried')).toBe(303);

  const documentId = await openedDocumentId(page);
  expect((await editorPageConfig(page)).documentType).toBe('cell');
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.nato);
  const stored = await storedFile(page, documentId);
  expect((await JSZip.loadAsync(stored)).file('docMetadata/LabelInfo.xml')).toBeNull();
  expect(sensitivityLabelProperties(await inspectXlsx(stored), NATO_SENSITIVITY_LABEL)).toMatchObject({
    Enabled: 'true',
    SiteId: DEMO_TENANT,
    Name: 'DCS-Diffusion-Restreinte-OTAN',
    Method: 'Privileged',
    ContentBits: '0',
  });
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', documentId))
    .toEqual([uploadEntry({ base: CODES.nato, read: { code: CODES.nato, source: 'sensitivity-label' }, signature: 'absent', lowering: false })]);
});

test('a file that another tool labelled gets its label', async ({ page }) => {
  const since = new Date();

  expect(await upload(page, await labelledByAnotherTool(), 'carried')).toBe(303);

  const documentId = await openedDocumentId(page);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.diffusionRestreinte);
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', documentId))
    .toEqual([uploadEntry({ base: CODES.diffusionRestreinte, read: { code: CODES.diffusionRestreinte, source: 'binding' }, signature: 'absent', lowering: false })]);
});

// The platform's own base label part, but under a name another tool could
// give it: the portal decides who opens the document from it too.
test('a base label part of any name decides who opens the uploaded document', async ({ page, browser }) => {
  const basePart = `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${CODES.diffusionRestreinte}" label="${CODES.diffusionRestreinte}"/>`;
  const buffer = await withCustomXmlPart(await readFile(TEMPLATE), basePart, 'urn:linagora:dcs:document:1', 'customXml/labels.xml');

  expect(await upload(page, { name: 'Fictional report with a renamed part.docx', mimeType: DOCX_TYPE, buffer }, 'carried')).toBe(303);

  const documentId = await openedDocumentId(page);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.diffusionRestreinte);
  const chloe = await signedInPage(browser, DEMO_ACCOUNTS.chloe);
  const answer = await chloe.goto(`/documents/${documentId}/edit`);
  expect(answer?.status()).toBe(403);
  await chloe.context().close();
});

// Office writes some package parts with a UTF-8 byte order mark, which XML
// allows; other tools write one in every part.
test('a Word file whose XML parts start with a byte order mark gets the label it carries, and opens', async ({ page }) => {
  const labelled = await withLabelMetadata(await readFile(TEMPLATE), {
    properties: wordLabelProperties(NATO_SENSITIVITY_LABEL, DEMO_TENANT, 2),
    labelList: wordLabelElement(NATO_SENSITIVITY_LABEL, DEMO_TENANT),
  });
  const zip = await JSZip.loadAsync(labelled);
  for (const name of Object.keys(zip.files).filter((part) => /\.(xml|rels)$/.test(part))) {
    zip.file(name, `\uFEFF${(await zip.file(name)?.async('string')) ?? ''}`);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  expect(await upload(page, { name: 'Fictional report with byte order marks.docx', mimeType: DOCX_TYPE, buffer }, 'carried')).toBe(303);

  const documentId = await openedDocumentId(page);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.nato);
  expect((await storedDocx(page, documentId)).baseLabel).toBe(CODES.nato);
});

test('a Word file with a sensitivity label of the mapped tenant gets the label the mapping pairs with it', async ({ page }) => {
  const since = new Date();
  const otherTenantLabel = randomUUID();
  const buffer = await withLabelMetadata(await readFile(TEMPLATE), {
    properties: wordLabelProperties(NATO_SENSITIVITY_LABEL, DEMO_TENANT, 2) + wordLabelProperties(otherTenantLabel, OTHER_TENANT, 9),
    labelList: wordLabelElement(NATO_SENSITIVITY_LABEL.toUpperCase(), DEMO_TENANT) + wordLabelElement(otherTenantLabel, OTHER_TENANT),
  });

  expect(await upload(page, { name: 'Fictional Word report.docx', mimeType: DOCX_TYPE, buffer }, 'carried')).toBe(303);

  const documentId = await openedDocumentId(page);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(CODES.nato);
  // The stored file holds no Sensitivity Label Information part, keeps the
  // other tenant's label, and carries the mapped tenant's as the platform
  // writes it.
  expect((await JSZip.loadAsync(await storedFile(page, documentId))).file('docMetadata/LabelInfo.xml')).toBeNull();
  const stored = await storedDocx(page, documentId);
  // The other tenant's element decided its label, which the stored file
  // keeps as custom properties, converted from the element.
  const otherTenant = sensitivityLabelProperties(stored, otherTenantLabel);
  expect(otherTenant).toMatchObject({ Enabled: 'true', SiteId: OTHER_TENANT, Method: 'Standard', ContentBits: '0' });
  expect(otherTenant).not.toHaveProperty('Name');
  expect(sensitivityLabelProperties(stored, NATO_SENSITIVITY_LABEL)).toMatchObject({ Enabled: 'true', SiteId: DEMO_TENANT, Name: 'DCS-Diffusion-Restreinte-OTAN', Method: 'Privileged', ContentBits: '0' });
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', documentId))
    .toEqual([uploadEntry({ base: CODES.nato, read: { code: CODES.nato, source: 'sensitivity-label' }, signature: 'absent', lowering: false })]);
});

test('a file that carries a label may be raised', async ({ page }) => {
  expect(await upload(page, await labelledByAnotherTool(), { marking: SPECIAL_FRANCE })).toBe(303);

  const documentId = await openedDocumentId(page);
  expect((await storedDocx(page, documentId)).baseLabel).toBe(CODES.specialFrance);
});

test('a cleared administrator may lower the label a file carries, which the journal marks', async ({ page }) => {
  const since = new Date();

  expect(await upload(page, await labelledByAnotherTool(), { marking: NON_PROTEGE })).toBe(303);

  const documentId = await openedDocumentId(page);
  expect((await storedDocx(page, documentId)).baseLabel).toBe(CODES.nonProtege);
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded, its label lowered', documentId))
    .toEqual([uploadEntry({ level: 30, base: CODES.nonProtege, read: { code: CODES.diffusionRestreinte, source: 'binding' }, lowering: true, user: 'alice' })]);
});

test('a file without a label needs one', async ({ page }) => {
  const unlabelled = { name: 'Fictional unlabelled notes.docx', mimeType: DOCX_TYPE, buffer: await readFile(TEMPLATE) };

  expect(await upload(page, unlabelled, 'carried')).toBe(400);

  await expect(page.getByText('The file carries no label: choose its base label.')).toBeVisible();
});

test('a label of another security policy is refused', async ({ page }) => {
  expect(await upload(page, await labelledByAnotherTool('OTHER-FR', 'urn:oid:2.25.1'), 'carried')).toBe(422);

  await expect(page.getByText("The file's label belongs to another security policy.")).toBeVisible();
});

test('a file changed after its binding was signed is accepted, and signed afresh', async ({ page }) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (docx) => docx.bindings.length === 1);
  // Someone changes the downloaded file's text outside the platform.
  const zip = await JSZip.loadAsync(await storedFile(page, documentId));
  const body = (await zip.file('word/document.xml')?.async('string')) ?? '';
  zip.file('word/document.xml', body.replace('</w:body>', '<w:p><w:r><w:t>Fictional sentence added later</w:t></w:r></w:p></w:body>'));
  const changed = await zip.generateAsync({ type: 'nodebuffer' });

  expect(await upload(page, { name: 'Fictional changed report.docx', mimeType: DOCX_TYPE, buffer: changed }, 'carried')).toBe(303);

  const uploadedId = await openedDocumentId(page);
  await expect
    .poll(() => documentLogEntries(since, 'Document uploaded', uploadedId))
    .toEqual([uploadEntry({ base: CODES.diffusionRestreinte, read: { code: CODES.diffusionRestreinte, source: 'base-label' }, signature: 'not-matched' })]);
  const stored = await storedFile(page, uploadedId);
  const bindable = (await storedDocx(page, uploadedId)).bindableParts;
  expect(await verifyBindingSignature(stored, demoAuthorityCertificate())).toEqual({ status: 0, manifest: `${bindable.length}/${bindable.length}` });
});

test.describe('an author who is no administrator', () => {
  test.use({ account: DEMO_ACCOUNTS.bob });

  test('may not lower the label a file carries', async ({ page }) => {
    expect(await upload(page, await labelledByAnotherTool(), { marking: NON_PROTEGE })).toBe(403);

    await expect(page.getByText("Only an administrator whose clearance allows the file's label may lower it.")).toBeVisible();
  });
});

test.describe('someone cleared for NON PROTÉGÉ only', () => {
  test.use({ account: DEMO_ACCOUNTS.chloe });

  test('may not upload a file whose label is beyond their clearance', async ({ page }) => {
    expect(await upload(page, await labelledByAnotherTool(), 'carried')).toBe(403);

    await expect(page.getByText("The file's label is beyond your clearance.")).toBeVisible();
  });
});
