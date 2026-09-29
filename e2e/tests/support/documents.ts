import { errors, expect, type Page, test } from '@playwright/test';
import JSZip from 'jszip';
import { DOMAIN } from './deployment.ts';
import { bubble } from './plugin.ts';

// Annotation naming a document a test created; the page fixture attaches its
// stored DOCX to the test's results as evidence.
export const CREATED_DOCUMENT = 'created document';

// Creates a fresh document from a portal template so that each test works on
// its own copy, then waits until the editor is ready.
export async function openNewDocument(page: Page, templateFileName: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: `New document from ${templateFileName}` }).click();
  return openedDocumentId(page);
}

// Waits until the portal has opened the editor on a document the test just
// created, and gives the document's id.
export async function openedDocumentId(page: Page): Promise<string> {
  await page.waitForURL(/\/documents\/[a-z0-9-]+\/edit$/);
  const match = /\/documents\/([a-z0-9-]+)\/edit$/.exec(new URL(page.url()).pathname);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected editor URL ${page.url()}`);
  }
  test.info().annotations.push({ type: CREATED_DOCUMENT, description: match[1] });
  await waitForEditorReady(page);
  return match[1];
}

export async function openDocument(page: Page, documentId: string): Promise<void> {
  await page.goto(`/documents/${documentId}/edit`);
  await waitForEditorReady(page);
}

// Starts the editor with a configuration the portal signed earlier, as an
// editor page kept open since would when it reconnects. It runs on a page the
// portal serves: Chromium keeps a page that Playwright serves itself from
// loading the editor's script, on the stack's private network. The page
// records the names of the events the editor raises. An editor that fails to
// load one of its modules raises none: on a page that watchEditorLoads
// watches, it is started once more. The editor has loaded in the test's
// browser before, so the wait is shorter than a first load's, which leaves a
// test the time to clean up after a failure.
export async function openWithEarlierConfig(page: Page, config: EditorPageConfig): Promise<void> {
  await startWithEarlierConfig(page, config);
  await waitForEditorStart(page, earlierEditorStarted, 60_000, async () => {
    await startWithEarlierConfig(page, config);
  });
}

// Whether the editor that openWithEarlierConfig started has started, which it
// tells before it raises any other event.
async function earlierEditorStarted(page: Page): Promise<boolean> {
  const started: unknown = await page.evaluate(() => Reflect.get(window, 'dcsEditorStarted'));
  return started === true;
}

async function startWithEarlierConfig(page: Page, config: EditorPageConfig): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    async ({ config, apiScriptUrl }) => {
      document.body.innerHTML = '<div id="editor" style="height: 100vh"></div>';
      document.body.style.margin = '0';
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = apiScriptUrl;
        script.addEventListener('load', () => {
          resolve();
        });
        script.addEventListener('error', () => {
          reject(new Error(`${apiScriptUrl} did not load`));
        });
        document.head.append(script);
      });
      const docsApi = Reflect.get(window, 'DocsAPI') as { DocEditor: new (id: string, config: unknown) => unknown }; // SAFETY: api.js has just installed it
      const events: string[] = [];
      Object.assign(window, { dcsEditorEvents: events });
      const record = (name: string) => () => {
        events.push(name);
      };
      new docsApi.DocEditor('editor', {
        ...config,
        events: {
          // The editor has started, before it raises any other event.
          onAppReady: () => {
            Reflect.set(window, 'dcsEditorStarted', true);
          },
          onDocumentReady: record('onDocumentReady'),
          onError: record('onError'),
          onOutdatedVersion: record('onOutdatedVersion'),
          onRequestRefreshFile: record('onRequestRefreshFile'),
          onWarning: record('onWarning'),
        },
      });
    },
    { config, apiScriptUrl: `https://docs.${DOMAIN}/web-apps/apps/api/documents/api.js` },
  );
}

// The events that the editor started by openWithEarlierConfig has raised.
export async function earlierEditorEvents(page: Page): Promise<string[]> {
  const events: unknown = await page.evaluate(() => Reflect.get(window, 'dcsEditorEvents'));
  return Array.isArray(events) ? events.map(String) : [];
}

// ONLYOFFICE's editor sometimes runs one of its own modules before the base
// class that module extends is ready, and then never becomes ready. The error
// comes from the Document Server's web apps, for instance "Cannot read
// properties of undefined (reading 'extend')" or "Common.UI.Window.extend is
// not a function"; loading the page again gets past it, as it would for a user.
function isModuleLoadingError(error: Error): boolean {
  return /\bextend\b/.test(error.message) && (error.stack ?? '').includes('/web-apps/');
}

// Pages whose editor failed to load since their last navigation.
const failedEditorLoads = new WeakSet<Page>();

// Records the editor's loading failures on a page, before it opens a document.
export function watchEditorLoads(page: Page): void {
  page.on('pageerror', (error) => {
    if (isModuleLoadingError(error)) {
      failedEditorLoads.add(page);
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      failedEditorLoads.delete(page);
    }
  });
}

export async function waitForEditorReady(page: Page): Promise<void> {
  await waitForEditorStart(page, editorPageReady, 180_000, async () => {
    await page.reload();
  });
}

async function editorPageReady(page: Page): Promise<boolean> {
  return (await page.locator('body').getAttribute('data-document-ready')) === 'true';
}

// Waits until the editor on a page has started, as `hasStarted` tells, and
// loads it once more with `loadAgain` when ONLYOFFICE has failed to load one
// of its modules, which the editor never gets past on its own.
async function waitForEditorStart(
  page: Page,
  hasStarted: (page: Page) => Promise<boolean>,
  timeout: number,
  loadAgain: () => Promise<void>,
): Promise<void> {
  if ((await editorLoadOutcome(page, hasStarted, timeout)) === 'failed') {
    await loadAgain();
    expect(await editorLoadOutcome(page, hasStarted, timeout)).toBe('started');
  }
}

async function editorLoadOutcome(page: Page, hasStarted: (page: Page) => Promise<boolean>, timeout: number): Promise<'started' | 'failed'> {
  const outcome = async (): Promise<'started' | 'failed' | 'loading'> => {
    if (await hasStarted(page)) {
      return 'started';
    }
    return failedEditorLoads.has(page) ? 'failed' : 'loading';
  };
  await expect.poll(outcome, { timeout }).not.toBe('loading');
  return (await outcome()) === 'started' ? 'started' : 'failed';
}

export interface EditorPageConfig {
  documentType: string;
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
  if (typeof value !== 'object' || value === null || !('documentType' in value) || !('document' in value) || !('editorConfig' in value)) {
    return false;
  }
  const { documentType, document, editorConfig } = value;
  return (
    typeof documentType === 'string' &&
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
  contentType: string | null;
  body: Buffer;
}

// Requests go through the browser: it resolves the stack's host names and
// carries the session cookie, which Playwright's Node-side client does not.
// A body, when given, goes as JSON.
export async function browserFetch(page: Page, url: string, method: 'GET' | 'POST' = 'GET', body: unknown = null): Promise<BrowserResponse> {
  const result = await page.evaluate(
    async ({ url, method, json }) => {
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        ...(json === null ? {} : { headers: { 'Content-Type': 'application/json' }, body: json }),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { status: response.status, contentType: response.headers.get('content-type'), base64: btoa(binary) };
    },
    { url, method, json: body === null ? null : JSON.stringify(body) },
  );
  return { status: result.status, contentType: result.contentType, body: Buffer.from(result.base64, 'base64') };
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

// ONLYOFFICE greets each new browser with a tip about its latest feature,
// drawn over the labelling panel: it goes once dismissed. Its button is a
// plain element, without the button role.
export async function dismissEditorTip(page: Page, timeout: number): Promise<void> {
  try {
    await page.frameLocator('iframe[name="frameEditor"]').getByText('Got it', { exact: true }).click({ timeout });
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
  }
}

// Puts the cursor at the start of the document, out of every portion: the
// bubble closes, and the first page shows from its top.
export async function moveCursorToStart(page: Page): Promise<void> {
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(bubble(page).owner()).toHaveCount(0);
}
