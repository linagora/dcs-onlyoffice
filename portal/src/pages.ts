import { isAdministrator } from './auth/administrators.ts';
import type { UserIdentity } from './auth/sessions.ts';
import type { DocumentTemplate, StoredDocument } from './documents.ts';
import type { SignedEditorConfig } from './editor-config.ts';
import { firstDayOf, lastDayOf } from './validity-period.ts';

// A clearance as the policy service's directory shows it.
export interface ClearanceEntry {
  email: string;
  name: string;
  nationality: string | null;
  policy: string;
  classification: string;
  // Each "<tag set>:<category>".
  categories: string[];
  validFrom: string;
  validUntil: string;
}

// What a clearance under one policy can hold.
export interface ClearanceChoices {
  classifications: string[];
  categories: string[];
}

// What the clearances page reports after a save.
export interface PageNotice {
  saved: string | null;
  error: string | null;
}

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
  header a { color: #fff; }
  td { vertical-align: top; }
  form.clearance { display: grid; gap: 0.4rem; }
  form.clearance fieldset { border: 1px solid #e4e7eb; padding: 0.3rem 0.6rem; }
  form.clearance button { justify-self: start; }
  .notice { padding: 0.5rem 0.8rem; border-radius: 4px; background: #e3f9e5; }
  .notice.error { background: #ffe3e3; }
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

// One form per entry: the person and the policy are fixed, the terms and
// the validity period are edited, among the choices the SPIF offers.
export function renderClearancesPage(
  user: UserIdentity,
  entries: ClearanceEntry[],
  choices: ReadonlyMap<string, ClearanceChoices>,
  notice: PageNotice,
): string {
  const rows = entries
    .map((entry) => {
      const offered = choices.get(entry.policy) ?? { classifications: [entry.classification], categories: entry.categories };
      const classifications = offered.classifications
        .map((name) => `<option${name === entry.classification ? ' selected' : ''}>${escapeHtml(name)}</option>`)
        .join('');
      const categories = offered.categories
        .map(
          (category) =>
            `<label><input type="checkbox" name="category" value="${escapeHtml(category)}"${entry.categories.includes(category) ? ' checked' : ''}> ${escapeHtml(category.replace(':', ': '))}</label>`,
        )
        .join('<br>');
      return `<tr>
  <td>${escapeHtml(entry.name)}<br><small>${escapeHtml(entry.email)}</small></td>
  <td>${escapeHtml(entry.nationality ?? '')}</td>
  <td>${escapeHtml(entry.policy)}</td>
  <td>
    <form class="clearance" method="post" action="/admin/clearances" aria-label="Clearance of ${escapeHtml(entry.email)}">
      <input type="hidden" name="email" value="${escapeHtml(entry.email)}">
      <input type="hidden" name="policy" value="${escapeHtml(entry.policy)}">
      <label>Highest classification <select name="classification">${classifications}</select></label>
      <fieldset><legend>Categories</legend>${categories}</fieldset>
      <input type="hidden" name="validFromWas" value="${escapeHtml(entry.validFrom)}">
      <input type="hidden" name="validUntilWas" value="${escapeHtml(entry.validUntil)}">
      <label>Valid from <input type="date" name="validFrom" value="${escapeHtml(firstDayOf(entry.validFrom))}"></label>
      <label>Valid through <input type="date" name="validThrough" value="${escapeHtml(lastDayOf(entry.validUntil))}"></label>
      <button type="submit">Save</button>
    </form>
  </td>
</tr>`;
    })
    .join('');
  const messages = [
    notice.saved === null ? '' : `<p class="notice" role="status">Clearance of ${escapeHtml(notice.saved)} saved.</p>`,
    notice.error === null ? '' : `<p class="notice error" role="alert">${escapeHtml(notice.error)}</p>`,
  ].join('');
  return page(
    'Clearances',
    `${renderHeader(user)}
<main>
  <h2>Clearances</h2>
  <p>A change applies at the next key request: a reader sees it once the document is reopened. A clearance is valid from the start of its first day to the end of its last day, UTC.</p>
  ${messages}
  <table>
    <thead><tr><th>Person</th><th>Nationality</th><th>Policy</th><th>Clearance</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
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
  <h1><a href="/">DCS ONLYOFFICE</a></h1>
  ${isAdministrator(user) ? '<a href="/admin/clearances">Clearances</a>' : ''}
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
