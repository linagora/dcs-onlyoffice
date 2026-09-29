import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { documentLogEntries, storeDocument } from './support/deployment.ts';
import { browserFetch, editorPageConfig, openDocument, openNewDocument, waitForEditorReady } from './support/documents.ts';
import { sensitivityLabelProperties } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginFrame, pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx, storedFile } from './support/portions.ts';
import { demoCertificate, verifyBindingSignature } from './support/signature.ts';
import { inspectXlsx, XLSX_TYPE } from './support/xlsx.ts';

const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_CODE = 'DEMO-FR:2';
const NON_PROTEGE_CODE = 'DEMO-FR:1';
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
// The fictional tenant of the example label mapping (deploy/spif), and the
// sensitivity label it pairs with DIFFUSION RESTREINTE.
const DEMO_TENANT = '00000000-0000-0000-0000-000000000000';
const DIFFUSION_RESTREINTE_LABEL = '10000000-0000-4000-8000-000000000002';

// A new workbook from the template, which the French officer labels
// DIFFUSION RESTREINTE in the panel, once its stored file carries the signed
// binding.
async function labelledWorkbook(page: Page): Promise<string> {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await forceSavedXlsx(page, documentId, (saved) => saved.baseLabel === DIFFUSION_RESTREINTE_CODE && saved.bindings[0]?.signed === true);
  return documentId;
}

// Stores a workbook's file as a new document that no editor has opened, as
// someone with access to the portal's storage could.
async function storedAsNewWorkbook(xlsx: Uint8Array, prefix: string): Promise<string> {
  const documentId = `${prefix}-${randomBytes(4).toString('hex')}`;
  await storeDocument(documentId, xlsx, '.xlsx');
  return documentId;
}

// A labelled workbook whose base label part names a document label, NON
// PROTEGE, that its labels in clear no longer give: an author's panel
// rewrites it, a reader's must not.
async function workbookWithStaleLabel(page: Page): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await storedFile(page, await labelledWorkbook(page)));
  for (const name of Object.keys(zip.files).filter((file) => /^customXml\/item\d+\.xml$/.test(file))) {
    const xml = (await zip.file(name)?.async('string')) ?? '';
    if (xml.includes(DOCUMENT_NAMESPACE)) {
      zip.file(name, xml.replace(`label="${DIFFUSION_RESTREINTE_CODE}"`, `label="${NON_PROTEGE_CODE}"`));
    }
  }
  return zip.generateAsync({ type: 'uint8array' });
}

// Records, in the panel's frame, the source of every command the panel sends
// the editor, from the panel's first command on.
async function recordPanelCommands(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = window.setInterval(() => {
      const plugin = window.Asc?.plugin;
      const callCommand = plugin?.callCommand;
      if (plugin === undefined || callCommand === undefined) {
        return;
      }
      window.clearInterval(spy);
      const sent: string[] = [];
      Reflect.set(window, 'dcsSentCommands', sent);
      plugin.callCommand = function (command, ...rest) {
        sent.push(String(command));
        return callCommand.call(this, command, ...rest);
      };
    }, 5);
  });
}

async function sentPanelCommands(page: Page): Promise<string[]> {
  const sent: unknown = await (await pluginFrame(page)).evaluate(() => Reflect.get(window, 'dcsSentCommands'));
  return Array.isArray(sent) ? sent.map(String) : [];
}

async function restrictedRows(page: Page, marking: string): Promise<number> {
  await page.goto('/');
  return page.locator('tr.restricted-document', { hasText: marking }).count();
}

test('a workbook labelled in the panel gets a journal entry, and is stored with its base label, a binding that xmlsec1 verifies and the sensitivity label', async ({ page }) => {
  const since = new Date();
  const documentId = await labelledWorkbook(page);

  const download = await browserFetch(page, `/documents/${documentId}/download`);

  await expect
    .poll(() => documentLogEntries(since, 'Base label changed in the panel', documentId))
    .toContainEqual(expect.objectContaining({ before: null, after: DIFFUSION_RESTREINTE_CODE, lowering: false }));
  expect(download.contentType).toBe(XLSX_TYPE);
  const saved = await inspectXlsx(download.body);
  expect(saved.bindings.map((binding) => binding.label)).toEqual([{ policy: 'DEMO-FR', classification: DIFFUSION_RESTREINTE, categories: [] }]);
  expect(saved.bindableParts).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'docProps/custom.xml']));
  const parts = saved.bindableParts.length;
  expect(await verifyBindingSignature(download.body, demoCertificate())).toEqual({ status: 0, manifest: `${parts}/${parts}` });
  const { ActionId, SetDate, ...label } = sensitivityLabelProperties(saved, DIFFUSION_RESTREINTE_LABEL);
  expect(label).toEqual({ Enabled: 'true', Method: 'Privileged', Name: 'DCS-Diffusion-Restreinte-Standard', SiteId: DEMO_TENANT, ContentBits: '0' });
  expect(ActionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(SetDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// The spreadsheet editor puts its cell settings in the panel's place at the
// first selection after its side menu opened, which a browser that
// remembers the menu open makes certain.
test('an author whose browser remembers the side menu open finds the panel shown once a workbook opens', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('sse-hide-right-settings', '0');
  });

  await openNewDocument(page, WORKBOOK_TEMPLATE);

  await expect(pluginPanel(page).getByLabel('Base label')).toBeVisible();
  // Still shown once the editor has settled.
  await page.waitForTimeout(5_000);
  await expect(pluginPanel(page).getByLabel('Base label')).toBeVisible();
});

test('a workbook beyond a clearance is listed with its marking only, and does not open', async ({ page, browser }) => {
  const chloe = await signedInPage(browser, DEMO_ACCOUNTS.chloe);
  try {
    const before = await restrictedRows(chloe, DIFFUSION_RESTREINTE);

    const documentId = await labelledWorkbook(page);

    expect(await restrictedRows(chloe, DIFFUSION_RESTREINTE)).toBe(before + 1);
    expect(await chloe.content()).not.toContain(documentId);
    for (const address of ['edit', 'view', 'download']) {
      expect((await browserFetch(chloe, `/documents/${documentId}/${address}`)).status).toBe(403);
    }
  } finally {
    await chloe.context().close();
  }
});

// An author's panel that finds the stored document label stale writes it
// again, as in a text document; the page marking does not count yet.
test("an author's panel rewrites a workbook's stale document label", async ({ page }) => {
  const documentId = await storedAsNewWorkbook(await workbookWithStaleLabel(page), 'workbook-stale-label');

  await openDocument(page, documentId);

  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.documentLabel !== NON_PROTEGE_CODE);
  expect([saved.baseLabel, saved.documentLabel]).toEqual([DIFFUSION_RESTREINTE_CODE, DIFFUSION_RESTREINTE_CODE]);
});

// The spreadsheet viewer, as the text viewer, runs the panel on the left: in
// view mode, ONLYOFFICE renders no right panel, as the research notes read in
// its code. The panel sends the viewer no command that writes, even to a
// workbook whose stored document label is stale.
test('the read-only viewer shows the panel with the document label, writes nothing, and the stored workbook stays as it was', async ({ page }) => {
  const stale = await workbookWithStaleLabel(page);
  const documentId = await storedAsNewWorkbook(stale, 'workbook-read-only');
  await recordPanelCommands(page);

  await page.goto(`/documents/${documentId}/view`);
  await waitForEditorReady(page);

  expect(await editorPageConfig(page)).toMatchObject({ editorConfig: { mode: 'view' }, document: { permissions: { edit: false } } });
  const panel = pluginPanel(page);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  await expect(panel.getByLabel('Base label')).toHaveCount(0);
  // Long enough for the panel to reread the workbook twice.
  await page.waitForTimeout(7_000);
  const sent = await sentPanelCommands(page);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.filter((command) => command.includes('.Add('))).toEqual([]);
  // Long enough for the Document Server to close the session.
  await page.goto('/');
  await page.waitForTimeout(10_000);
  expect(await storedFile(page, documentId)).toEqual(Buffer.from(stale));
});

test('a stored workbook changed outside the portal is logged when it is served, and still opens', async ({ page }) => {
  const since = new Date();
  const zip = await JSZip.loadAsync(await storedFile(page, await labelledWorkbook(page)));
  const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
  zip.file('xl/worksheets/sheet1.xml', `${sheet}<!-- changed outside the portal -->`);
  const documentId = await storedAsNewWorkbook(await zip.generateAsync({ type: 'uint8array' }), 'workbook-signature-check');

  await openDocument(page, documentId);

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);
  const logged = (servedTo: string): unknown =>
    expect.objectContaining({ servedTo, reason: 'Parts changed since signing', changedParts: ['xl/worksheets/sheet1.xml'] });
  await expect.poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId)).toContainEqual(logged('document-server'));

  await storedFile(page, documentId);

  await expect.poll(() => documentLogEntries(since, 'Stored file no longer matches its signature', documentId)).toContainEqual(logged('download'));
});
