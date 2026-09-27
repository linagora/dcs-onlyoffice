import type { UserIdentity } from './auth/sessions.ts';
import type { DocumentTemplate, StoredDocument } from './documents.ts';
import type { SignedEditorConfig } from './editor-config.ts';

export interface EditorPageOptions {
  title: string;
  apiScriptUrl: string;
  editorConfig: SignedEditorConfig;
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 0; color: #1f2933; }
  header { background: #1f3a5f; color: #fff; padding: 0.8rem 1.5rem; display: flex; align-items: center; gap: 1rem; }
  header h1 { font-size: 1.1rem; margin: 0; flex: 1; }
  header button { background: none; border: 1px solid #fff; color: #fff; border-radius: 4px; padding: 0.2rem 0.6rem; }
  main { padding: 1.5rem; max-width: 60rem; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #e4e7eb; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions a { margin-left: 0.8rem; }
  form { display: inline; }
  button { font: inherit; cursor: pointer; }
`;

export function renderDocumentListPage(
  user: UserIdentity,
  documents: StoredDocument[],
  templates: DocumentTemplate[],
): string {
  const documentRows =
    documents.length === 0
      ? '<p>No document yet.</p>'
      : `<table>${documents
          .map(
            (document) => `<tr>
  <td><a href="/documents/${document.id}/edit">${escapeHtml(document.fileName)}</a></td>
  <td class="actions">
    <a href="/documents/${document.id}/view" aria-label="Read ${escapeHtml(document.fileName)}">Read</a>
    <a href="/documents/${document.id}/download" aria-label="Download ${escapeHtml(document.fileName)}">Download</a>
  </td>
</tr>`,
          )
          .join('')}</table>`;
  const templateButtons = templates
    .map(
      (template) => `<form method="post" action="/documents">
  <input type="hidden" name="template" value="${escapeHtml(template.id)}">
  <button type="submit">New document from ${escapeHtml(template.fileName)}</button>
</form>`,
    )
    .join(' ');
  return page(
    'Documents',
    `${renderHeader(user)}
<main>
  <h2>Documents</h2>
  ${documentRows}
  <h2>Templates</h2>
  <p>${templateButtons}</p>
</main>`,
  );
}

export function renderMessagePage(title: string, message: string): string {
  return page(
    title,
    `<header><h1>DCS ONLYOFFICE</h1></header>
<main>
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Back to the portal</a></p>
</main>`,
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

function renderHeader(user: UserIdentity): string {
  return `<header>
  <h1>DCS ONLYOFFICE</h1>
  <span>Signed in as ${escapeHtml(user.name)}</span>
  <form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>
</header>`;
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
