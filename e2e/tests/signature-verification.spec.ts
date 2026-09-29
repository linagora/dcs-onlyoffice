import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { documentLogEntries, storeDocument } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { BINDING_NAMESPACE, inspectDocx } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedDocx, storedFile } from './support/portions.ts';
import { changedSinceSigning, demoCertificate, verifyBindingSignature } from './support/signature.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// Codes of the demo SPIF's labels.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const NON_PROTEGE_CODE = 'DEMO-FR:1';

// The signed file of a new document labelled DIFFUSION RESTREINTE.
async function signedFile(page: Page): Promise<Buffer> {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => saved.bindings[0]?.signed === true);
  return storedFile(page, documentId);
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
  expect(await verifyBindingSignature(await storedFile(page, documentId), demoCertificate())).toEqual({ status: 0, manifest: `${parts}/${parts}` });
});
