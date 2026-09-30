import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { deploymentSetting, documentLogEntries, newSigningKey, storeDocument, withPolicySettings } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { BINDING_NAMESPACE, DOCX_TYPE, inspectDocx } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, leaveAndWaitForSave, storedDocx, storedFile } from './support/portions.ts';
import {
  certificateBody,
  changedSinceSigning,
  demoAuthorityCertificate,
  demoRevocationList,
  signatureMismatch,
  verifyBindingSignature,
} from './support/signature.ts';
import { uploadedDocumentId } from './support/uploads.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// Codes of the demo SPIF's labels.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const NON_PROTEGE_CODE = 'DEMO-FR:1';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
// A DOCX that the panel never labelled: the portal's template.
const TEMPLATE = new URL('../../deploy/demo/documents/exercise-northwind.docx', import.meta.url);

// The signed file of a new document labelled DIFFUSION RESTREINTE.
async function signedFile(page: Page): Promise<Buffer> {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.signed === true);
  return storedFile(page, documentId);
}

// A document uploaded with the label DIFFUSION RESTREINTE, which the portal
// stores signed; no editing session saves it afterwards.
async function uploadedSignedDocument(page: Page): Promise<string> {
  return uploadedDocumentId(page, { name: 'Fictional exercise report.docx', mimeType: DOCX_TYPE, buffer: await readFile(TEMPLATE) }, DIFFUSION_RESTREINTE_CODE);
}

// A copy of a package whose XML parts `change` rewrites, given each part's
// name and text.
async function rewritten(docx: Uint8Array, change: (name: string, xml: string) => string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  for (const name of Object.keys(zip.files).filter((file) => file.endsWith('.xml'))) {
    const xml = (await zip.file(name)?.async('string')) ?? '';
    zip.file(name, change(name, xml));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// Stores a file as a new document, as someone with access to the portal's
// storage could.
async function storedAsNewDocument(docx: Uint8Array): Promise<string> {
  const documentId = `signature-check-${randomBytes(4).toString('hex')}`;
  await storeDocument(documentId, docx);
  return documentId;
}

test('a stored file changed outside the portal is logged when it is served, and still opens', async ({ page }) => {
  const since = new Date();
  const changed = await rewritten(await signedFile(page), (name, xml) => (name === 'docProps/app.xml' ? `${xml}<!-- changed outside the portal -->` : xml));
  const documentId = await storedAsNewDocument(changed);

  await openDocument(page, documentId);

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await expect
    .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
    .toContainEqual(changedSinceSigning('document-server', ['docProps/app.xml']));

  await storedFile(page, documentId);

  await expect
    .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
    .toContainEqual(changedSinceSigning('download', ['docProps/app.xml']));
});

test('a stored file whose base label was lowered outside the portal is logged, when it is served, as changed since signing', async ({ page }) => {
  const since = new Date();
  let baseLabelPart = '';
  const lowered = await rewritten(await signedFile(page), (name, xml) => {
    const changed = xml.replace(`base="${DIFFUSION_RESTREINTE_CODE}"`, `base="${NON_PROTEGE_CODE}"`);
    if (changed !== xml) {
      baseLabelPart = name;
    }
    return changed;
  });
  expect((await inspectDocx(Buffer.from(lowered))).baseLabel).toBe(NON_PROTEGE_CODE);
  const documentId = await storedAsNewDocument(lowered);

  await openDocument(page, documentId);

  await expect
    .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
    .toContainEqual(changedSinceSigning('document-server', [baseLabelPart]));
});

test("another document's signed file put in a document's place is logged, when it is served, as signed for another document, and still opens", async ({ page }) => {
  const since = new Date();
  const documentId = await storedAsNewDocument(await signedFile(page));

  await openDocument(page, documentId);

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await expect
    .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
    .toContainEqual(signatureMismatch('document-server', 'Signed for another document'));
});

test('an earlier signed version of a document put back in its place is logged, when it is served, as not the latest, and still opens', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.signed === true);
  const earlier = await storedFile(page, documentId);
  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph of a later version') });
  await leaveAndWaitForSave([page], documentId, 1);
  const since = new Date();
  await storeDocument(documentId, earlier);

  await openDocument(page, documentId);

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await expect
    .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
    .toContainEqual(signatureMismatch('document-server', 'Not the latest signed version'));
});

test('a file stored before signing existed is logged as unsigned, opens, and is signed at its next save', async ({ page }) => {
  const since = new Date();
  const unsigned = await rewritten(await signedFile(page), (_name, xml) =>
    xml.includes(BINDING_NAMESPACE) ? xml.replace(/<Signature\b[\s\S]*<\/Signature>/, '') : xml,
  );
  const documentId = await storedAsNewDocument(unsigned);

  await openDocument(page, documentId);

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await expect.poll(() => documentLogEntries(since, 'Stored file unsigned', documentId)).toContainEqual(expect.objectContaining({ servedTo: 'document-server' }));
  expect(documentLogEntries(since, 'Stored file no longer matches its signature', documentId)).toEqual([]);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: SPECIAL_FRANCE });

  const saved = await forceSavedDocx(page, documentId, (docx) => docx.bindings[0]?.signed === true);
  const parts = saved.bindableParts.length;
  expect(await verifyBindingSignature(await storedFile(page, documentId), demoAuthorityCertificate())).toEqual({ status: 0, manifest: `${parts}/${parts}` });
});

test('after a change of signing key, a file signed with the previous one is not logged when it is served, and its next save is signed with the new one', async ({
  page,
}) => {
  const documentId = await uploadedSignedDocument(page);
  // The same file, changed outside the portal, is logged whatever the key:
  // its entry shows that the check of the files served runs, and that it
  // found the previous key's certificate trusted.
  const changedId = await storedAsNewDocument(
    await rewritten(await storedFile(page, documentId), (name, xml) => (name === 'docProps/app.xml' ? `${xml}<!-- changed outside the portal -->` : xml)),
  );
  const newKey = await newSigningKey();

  await withPolicySettings(newKey, async () => {
    const since = new Date();
    await openDocument(page, documentId);
    await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
    await storedFile(page, changedId);

    await expect
      .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', changedId))
      .toContainEqual(changedSinceSigning('download', ['docProps/app.xml']));
    expect(documentLogEntries(since, 'Stored file no longer matches its signature', documentId)).toEqual([]);
    expect((await storedDocx(page, documentId)).bindings[0]?.signingCertificate).toBe(certificateBody(deploymentSetting('BINDING_SIGNING_CERTIFICATE')));

    await pluginPanel(page).getByLabel('Base label').selectOption({ label: SPECIAL_FRANCE });
    const saved = await forceSavedDocx(page, documentId, (docx) => docx.baseLabel === SPECIAL_FRANCE_CODE && docx.bindings[0]?.signed === true);
    expect(saved.bindings[0]?.signingCertificate).toBe(certificateBody(newKey.BINDING_SIGNING_CERTIFICATE));
  });
});

test('a file signed with a certificate that its authority revoked is logged, when it is served, with that reason, and still opens', async ({ page }) => {
  const documentId = await uploadedSignedDocument(page);
  // The key changes, and the demo authority revokes the previous one's
  // certificate, as it would after a leak.
  const settings = { ...(await newSigningKey()), BINDING_REVOCATION_LISTS: await demoRevocationList(deploymentSetting('BINDING_SIGNING_CERTIFICATE')) };

  await withPolicySettings(settings, async () => {
    const since = new Date();
    await openDocument(page, documentId);

    await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
    await expect
      .poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId))
      .toContainEqual(signatureMismatch('document-server', 'The signing certificate was revoked'));
  });
});
