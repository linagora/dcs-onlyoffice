import { isAdministrator } from './auth/administrators.ts';
import type { UserIdentity } from './auth/sessions.ts';
import type { DocumentDecision, Marking } from './document-access.ts';
import { DOCUMENT_FORMATS, type DocumentTemplate, FORMAT_NAMES, type StoredDocument } from './documents.ts';
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
  // A workbook's screen marking, with the marking of the document label the
  // stored file names, null when unknown; null for a text document.
  screenMarking: { initial: Marking | null } | null;
}

// The editor fills the page; a workbook's screen marking takes a strip above
// and below it, whose colours the page's script sets.
const EDITOR_PAGE_STYLE = `
  html, body { height: 100%; margin: 0; }
  #editor { height: 100%; }
  body.screen-marked { display: flex; flex-direction: column; }
  body.screen-marked #editor { flex: 1 1 auto; height: auto; min-height: 0; }
  .screen-marking { flex: none; padding: 3px 8px; text-align: center; font: bold 13px/1.4 system-ui, sans-serif; }
`;

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
  form.upload { display: grid; gap: 0.6rem; justify-items: start; }
  .notice { padding: 0.5rem 0.8rem; border-radius: 4px; background: #e3f9e5; }
  .notice.error { background: #ffe3e3; }
  .label-swatch { display: inline-block; width: 0.8rem; height: 0.8rem; margin-right: 0.4rem; border-radius: 2px; vertical-align: middle; }
`;

// A label a person may give an uploaded document.
export interface UploadLabel {
  code: string;
  marking: Marking;
}

// What the upload form offers: the labels the person's clearance allows,
// null when the policy service cannot tell, and the largest file it takes.
export interface UploadForm {
  labels: UploadLabel[] | null;
  limitMegabytes: number;
}

// A stored document, with what the signed-in person may do with it.
export interface ListedDocument {
  document: StoredDocument;
  decision: DocumentDecision;
}

// A document the person may not open shows only its base label's marking:
// its name and identifier can be sensitive too, and the restricted documents
// come last, ordered by marking, so that their place reveals nothing either.
export function renderDocumentListPage(user: UserIdentity, documents: ListedDocument[], templates: DocumentTemplate[], upload: UploadForm): string {
  const openRows = documents.flatMap(({ document, decision }) =>
    decision.open
      ? [
          `<tr>
  <td><a href="/documents/${document.id}/edit">${escapeHtml(document.fileName)}</a></td>
  <td class="actions">
    <a href="/documents/${document.id}/view" aria-label="Read ${escapeHtml(document.fileName)}">Read</a>
    <a href="/documents/${document.id}/download" aria-label="Download ${escapeHtml(document.fileName)}">Download</a>
  </td>
</tr>`,
        ]
      : [],
  );
  const restrictedRows = documents
    .flatMap(({ decision }) => (decision.open ? [] : [restrictionText(decision)]))
    .sort()
    .map((text) => `<tr class="restricted-document">\n  <td colspan="2">Restricted document: ${text}</td>\n</tr>`);
  const documentRows = documents.length === 0 ? '<p>No document yet.</p>' : `<table>${[...openRows, ...restrictedRows].join('')}</table>`;
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
  <h2>Upload</h2>
  ${renderUploadForm(upload)}
</main>`,
  );
}

// What the upload form's file field offers: each format's extension and
// media type.
const UPLOAD_ACCEPT = Object.values(DOCUMENT_FORMATS)
  .flatMap(({ extension, contentType }) => [extension, contentType])
  .join(',');

// A DOCX or an XLSX and its base label: the label the file carries, or one
// among those the person's clearance allows.
function renderUploadForm(upload: UploadForm): string {
  if (upload.labels === null) {
    return '<p>Uploads are unavailable: the policy service cannot tell which labels your clearance allows. Try again later.</p>';
  }
  if (upload.labels.length === 0) {
    return '<p>Your clearance allows no label to give an uploaded document.</p>';
  }
  const options = [
    '<option value="">The label the file carries</option>',
    ...upload.labels.map((label) => `<option value="${escapeHtml(label.code)}">${escapeHtml(label.marking.text)}</option>`),
  ].join('');
  return `<form class="upload" method="post" action="/documents/upload" enctype="multipart/form-data">
  <label>${FORMAT_NAMES} file, up to ${upload.limitMegabytes} MB <input type="file" name="file" accept="${UPLOAD_ACCEPT}" required></label>
  <label>Base label <select name="base">${options}</select></label>
  <button type="submit">Upload</button>
</form>`;
}

// The answer to the addresses of a document the person may not open, which
// never names it.
export function renderRestrictedDocumentPage(user: UserIdentity, decision: Exclude<DocumentDecision, { open: true }>): string {
  const explanation =
    decision.reason === 'clearance'
      ? `This document's base label is beyond your clearance: ${restrictionText(decision)}`
      : 'Whether this document opens for you cannot be decided right now. Try again later.';
  return page(
    'Access denied',
    `${renderHeader(user)}
<main>
  <h2>Access denied</h2>
  <p>${explanation}</p>
  <p><a href="/">Back to the documents</a></p>
</main>`,
  );
}

// Shown while the session the portal ended after a base label change sends
// its last save; the page tries again by itself.
export function renderSavingDocumentPage(user: UserIdentity): string {
  return page(
    'Saving the document',
    `${renderHeader(user)}
<main>
  <h2>Saving the document</h2>
  <p>This document's base label changed, so its editing session ended. The document opens as soon as its last changes are saved.</p>
  <p><a href="/">Back to the documents</a></p>
</main>`,
    2,
  );
}

function restrictionText(decision: Exclude<DocumentDecision, { open: true }>): string {
  if (decision.reason === 'unavailable') {
    return '<span class="marking">access cannot be checked right now</span>';
  }
  return renderMarking(decision.marking);
}

function renderMarking(marking: Marking | null): string {
  if (marking === null) {
    return '<span class="marking">label unknown</span>';
  }
  const swatch = marking.color === null ? '' : `<span class="label-swatch" style="background-color: ${escapeHtml(marking.color)}"></span>`;
  return `<span class="marking">${swatch}${escapeHtml(marking.text)}</span>`;
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

// A workbook's page shows its screen marking above and below the editor,
// which ONLYOFFICE's spreadsheet editor leaves out on screen: the script fills
// the strips from the stored label, then from the panel's.
export function renderEditorPage(options: EditorPageOptions): string {
  const { screenMarking } = options;
  const strip = screenMarking === null ? '' : '<div class="screen-marking" data-testid="screen-marking"></div>';
  const initialMarking =
    screenMarking === null ? '' : `\n  <script type="application/json" id="screen-marking">${serializeForScript(screenMarking.initial)}</script>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(options.title)}</title>
  <style>${EDITOR_PAGE_STYLE}</style>
</head>
<body${screenMarking === null ? '' : ' class="screen-marked"'}>
  ${strip}
  <div id="editor"></div>
  ${strip}
  <script type="application/json" id="editor-config">${serializeForScript(options.editorConfig)}</script>${initialMarking}
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

function page(title: string, body: string, refreshSeconds: number | null = null): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">${refreshSeconds === null ? '' : `\n  <meta http-equiv="refresh" content="${refreshSeconds}">`}
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
