import type { StoredDocument } from './documents.ts';
import type { SignedEditorConfig } from './editor-config.ts';

export interface EditorPageOptions {
  title: string;
  apiScriptUrl: string;
  editorConfig: SignedEditorConfig;
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 0; color: #1f2933; }
  header { background: #1f3a5f; color: #fff; padding: 0.8rem 1.5rem; }
  header h1 { font-size: 1.1rem; margin: 0; }
  main { padding: 1.5rem; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.4rem 0; }
`;

export function renderDocumentListPage(documents: StoredDocument[]): string {
  const items =
    documents.length === 0
      ? '<p>No document yet.</p>'
      : `<ul>${documents
          .map((document) => `<li><a href="/documents/${document.id}/edit">${escapeHtml(document.fileName)}</a></li>`)
          .join('')}</ul>`;
  return page(
    'Documents',
    `<header><h1>DCS ONLYOFFICE</h1></header><main><h2>Documents</h2>${items}</main>`,
  );
}

export function renderEditorPage(options: EditorPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(options.title)}</title>
  <style>html, body { height: 100%; margin: 0; } #editor { height: 100%; }</style>
</head>
<body>
  <div id="editor"></div>
  <script type="application/json" id="editor-config">${serializeForScript(options.editorConfig)}</script>
  <script src="${escapeHtml(options.apiScriptUrl)}"></script>
  <script src="/static/editor.js"></script>
</body>
</html>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} - DCS ONLYOFFICE</title>
  <style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// JSON embedded in a script element must not be able to close that element.
function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
