import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';

// Creates a fresh document from a portal template so that each test works on
// its own copy, then waits until the editor is ready.
export async function openNewDocument(page: Page, templateFileName: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: `New document from ${templateFileName}` }).click();
  await page.waitForURL(/\/documents\/[a-z0-9-]+\/edit$/);
  const match = /\/documents\/([a-z0-9-]+)\/edit$/.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected editor URL ${page.url()}`);
  }
  await waitForEditorReady(page);
  return match[1];
}

export async function openDocument(page: Page, documentId: string): Promise<void> {
  await page.goto(`/documents/${documentId}/edit`);
  await waitForEditorReady(page);
}

export async function waitForEditorReady(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-document-ready', 'true', { timeout: 180_000 });
}

interface EditorPageConfig {
  document: { key: string; permissions: { edit: boolean } };
  editorConfig: { mode: string; user: { id: string; name: string } };
}

export async function editorPageConfig(page: Page): Promise<EditorPageConfig> {
  const config: unknown = JSON.parse((await page.locator('#editor-config').textContent()) ?? 'null');
  if (!isEditorPageConfig(config)) {
    throw new Error('The editor page carries no editor configuration');
  }
  return config;
}

export async function editorDocumentKey(page: Page): Promise<string> {
  return (await editorPageConfig(page)).document.key;
}

function isEditorPageConfig(value: unknown): value is EditorPageConfig {
  if (typeof value !== 'object' || value === null || !('document' in value) || !('editorConfig' in value)) {
    return false;
  }
  const { document, editorConfig } = value;
  return (
    typeof document === 'object' &&
    document !== null &&
    'key' in document &&
    typeof document.key === 'string' &&
    typeof editorConfig === 'object' &&
    editorConfig !== null &&
    'user' in editorConfig &&
    typeof editorConfig.user === 'object' &&
    editorConfig.user !== null &&
    'id' in editorConfig.user &&
    'name' in editorConfig.user
  );
}

export async function typeInDocument(page: Page, text: string): Promise<void> {
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.type(text);
}

// The editor draws the document on a canvas; copying everything is how a user
// gets its text out, and needs the clipboard permissions.
export async function readDocumentText(page: Page): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('ControlOrMeta+c');
        text = await page.evaluate(async () => navigator.clipboard.readText());
        return text.length;
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBeGreaterThan(0);
  return text;
}

interface BrowserResponse {
  status: number;
  body: Buffer;
}

// Requests go through the browser: it resolves the stack's host names and
// carries the session cookie, which Playwright's Node-side client does not.
export async function browserFetch(page: Page, url: string, method: 'GET' | 'POST' = 'GET'): Promise<BrowserResponse> {
  const result = await page.evaluate(
    async ({ url, method }) => {
      const response = await fetch(url, { method, credentials: 'same-origin' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { status: response.status, base64: btoa(binary) };
    },
    { url, method },
  );
  return { status: result.status, body: Buffer.from(result.base64, 'base64') };
}

export async function requestForceSave(page: Page, documentId: string): Promise<number> {
  const response = await browserFetch(page, `/documents/${documentId}/forcesave`, 'POST');
  return response.status;
}

export async function storedDocumentText(page: Page, documentId: string): Promise<string> {
  const response = await browserFetch(page, `/documents/${documentId}/download`);
  expect(response.status).toBe(200);
  return docxText(response.body);
}

export async function docxText(docx: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (documentXml === undefined) {
    throw new Error('The DOCX has no word/document.xml part');
  }
  return [...documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map(([paragraph]) => [...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(([, text]) => text).join(''))
    .join('\n');
}
