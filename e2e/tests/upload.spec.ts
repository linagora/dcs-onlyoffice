import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS } from './support/accounts.ts';
import { documentLogEntries, portalLog } from './support/deployment.ts';
import { docxText, openedDocumentId } from './support/documents.ts';
import { sensitivityLabelProperties } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';
import { storedDocx, storedFile } from './support/portions.ts';
import { demoCertificate, verifyBindingSignature } from './support/signature.ts';

// A DOCX that the panel never labelled: the portal's template, as it stands
// in the repository.
const UNLABELLED_DOCX = new URL('../../deploy/demo/documents/exercise-northwind.docx', import.meta.url);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// An uploaded file's name, which the document keeps, accents and dash
// included.
const UPLOADED_NAME = 'Compte rendu de mission – été.docx';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
// The demo SPIF's code for DIFFUSION RESTREINTE, which the journal names,
// and the sensitivity label the example label mapping pairs with it.
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const DIFFUSION_RESTREINTE_LABEL = '10000000-0000-4000-8000-000000000002';
// The first bytes of an OLE compound file ([MS-CFB] §2.2), the container of
// an encrypted Office document ([MS-OFFCRYPTO] §1.3.3.4).
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

interface UploadedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

// A file as Microsoft Purview encrypts it: a compound file whose directory
// names the rights management data space, in UTF-16.
function purviewEncryptedFile(): UploadedFile {
  const names = ['\u0006DataSpaces', 'DRMEncryptedDataSpace', 'EncryptedPackage'].map((name) => Buffer.from(`${name}\0`, 'utf16le'));
  return { name: 'Fictional protected report.docx', mimeType: DOCX_TYPE, buffer: Buffer.concat([COMPOUND_FILE_SIGNATURE, Buffer.alloc(504), ...names]) };
}

// Uploads a file through the form of the portal's home page, with a base
// label the form offers or, as someone altering the page could, one it does
// not offer; gives the portal's answer.
async function upload(page: Page, file: UploadedFile, label: { marking: string } | { code: string }): Promise<number> {
  await page.goto('/');
  const labels = page.getByLabel('Base label');
  if ('code' in label) {
    await labels.evaluate((select, code) => {
      select.append(new Option(code, code));
    }, label.code);
    await labels.selectOption(label.code);
  } else {
    await labels.selectOption({ label: label.marking });
  }
  await page.getByLabel('DOCX file, up to 20 MB').setInputFiles(file);
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/documents/upload'));
  await page.getByRole('button', { name: 'Upload' }).click();
  return (await response).status();
}

test('the French officer uploads an unlabelled DOCX, which opens in the editor with the base label chosen', async ({ page }) => {
  const since = new Date();
  const docx = await readFile(UNLABELLED_DOCX);

  await upload(page, { name: UPLOADED_NAME, mimeType: DOCX_TYPE, buffer: docx }, { marking: DIFFUSION_RESTREINTE });

  const documentId = await openedDocumentId(page);
  expect(documentId).toMatch(/^compte-rendu-de-mission-ete-[0-9a-f]{8}$/);
  await expect(page).toHaveTitle(UPLOADED_NAME);
  await expect(pluginPanel(page).getByLabel('Base label')).toHaveValue(DIFFUSION_RESTREINTE_CODE);
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);

  // The stored file holds the base label part and a binding of the document
  // label that the policy computed, signed, with its sensitivity label.
  const stored = await storedDocx(page, documentId);
  expect(stored.baseLabel).toBe(DIFFUSION_RESTREINTE_CODE);
  expect(stored.bindings.map((binding) => binding.label)).toEqual([{ policy: 'DEMO-FR', classification: DIFFUSION_RESTREINTE, categories: [] }]);
  expect(sensitivityLabelProperties(stored, DIFFUSION_RESTREINTE_LABEL)).toMatchObject({ Enabled: 'true', Name: 'DCS-Diffusion-Restreinte-Standard' });
  const bindable = stored.bindableParts;
  expect(await verifyBindingSignature(await storedFile(page, documentId), demoCertificate())).toEqual({ status: 0, manifest: `${bindable.length}/${bindable.length}` });

  // The document appears in the list under the uploaded file's name, which
  // its download gives too.
  await page.goto('/');
  await expect(page.locator(`a[href="/documents/${documentId}/edit"]`)).toHaveText(UPLOADED_NAME);
  const downloadLink = page.locator(`a[href="/documents/${documentId}/download"]`);
  await expect(downloadLink).toHaveAccessibleName(`Download ${UPLOADED_NAME}`);
  const download = page.waitForEvent('download');
  await downloadLink.click();
  expect((await download).suggestedFilename()).toBe(UPLOADED_NAME);

  // The journal records the upload: the document, the person and the base
  // label, without any of the document's text.
  await expect.poll(() => documentLogEntries(since, 'Document uploaded', documentId)).toEqual([
    { level: 30, time: expect.any(Number), pid: expect.any(Number), hostname: expect.any(String), documentId, base: DIFFUSION_RESTREINTE_CODE, user: 'alice', msg: 'Document uploaded' },
  ]);
  const sentence = (await docxText(docx)).split(/(?<=[.!?])\s+/).find((candidate) => candidate.length > 20);
  expect(sentence).toBeDefined();
  expect(portalLog(since)).not.toContain(sentence);
});

test('a file that Microsoft Purview encrypted is refused, and says what to do', async ({ page }) => {
  expect(await upload(page, purviewEncryptedFile(), { marking: DIFFUSION_RESTREINTE })).toBe(422);

  await expect(page.getByRole('heading', { name: 'Upload refused' })).toBeVisible();
  await expect(page.getByText('Microsoft Purview encrypted the file: remove its protection first')).toBeVisible();
});

test('a file that is not a DOCX is refused', async ({ page }) => {
  const notes = { name: 'Fictional notes.docx', mimeType: DOCX_TYPE, buffer: Buffer.from('Fictional notes, not a document') };

  expect(await upload(page, notes, { marking: DIFFUSION_RESTREINTE })).toBe(422);

  await expect(page.getByText('The file is no DOCX package')).toBeVisible();
});

test.describe('someone cleared for NON PROTÉGÉ only', () => {
  test.use({ account: DEMO_ACCOUNTS.chloe });

  test('is offered only the labels their clearance allows', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByLabel('Base label').locator('option')).toHaveText(['NON PROTÉGÉ']);
  });

  // DIFFUSION RESTREINTE, beyond the clearance, and NON PROTÉGÉ with the
  // informative category MORE RESTRICTIVE PORTIONS, which the clearance
  // allows but only the document label takes.
  for (const code of [DIFFUSION_RESTREINTE_CODE, 'DEMO-FR:1/3.1']) {
    test(`is refused the base label ${code}, which the form does not offer`, async ({ page }) => {
      const report = { name: 'Fictional mission report.docx', mimeType: DOCX_TYPE, buffer: await readFile(UNLABELLED_DOCX) };

      expect(await upload(page, report, { code })).toBe(403);

      await expect(page.getByText('The base label is not among those your clearance allows.')).toBeVisible();
    });
  }
});
