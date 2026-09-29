import type {
  ControlSnapshot,
  DocumentLabelScope,
  DocumentSnapshot,
  HeaderFooterSnapshot,
  PortionBlockScope,
  PortionWriteScope,
  SelectedContent,
  SelectionReading,
  SelectionReadingScope,
  SelectionRefusal,
  SelectionScope,
  SheetSnapshot,
  WriteOutcome,
} from './commands.ts';
import { readDocumentCommand, readParagraphsCommand, writeLabellingCommand } from './document-commands.ts';
import type { EnvelopeClient } from './envelopes.ts';
import { messages } from './messages.ts';
import { callEditorMethod, type EditorType, runCommand } from './onlyoffice.ts';
import {
  type DocumentLabel,
  type DocumentLabelRequest,
  fetchAdatp4774,
  fetchDocumentLabel,
  fetchLabelAttributes,
  type LabelView,
  type PackageKind,
} from './policy.ts';
import type { PortionState } from './portal.ts';
import {
  placeholderAtActiveCellCommand,
  readSelectionCommand,
  readWorkbookCommand,
  selectPlaceholderCommand,
  writeWorkbookLabellingCommand,
} from './workbook-commands.ts';

// What the panel does in each editor: the commands that read the labels and
// write them, what the page marking the document shows is, whether it inserts
// protected portions and changes and deletes them, how it reads the selected
// content it protects, how it selects a portion's placeholder and learns which
// one holds the selection, and what the editor does to the panel as the
// document loads.
export const EDITORS: Readonly<
  Record<
    EditorType,
    {
      // The format of the documents it edits.
      packageKind: PackageKind;
      read: () => DocumentSnapshot;
      write: () => WriteOutcome;
      pageMarkingOf: (snapshot: DocumentSnapshot) => ShownPageMarking | null;
      insertsPortions: boolean;
      editsPortions: boolean;
      // Reads the selected content the panel protects.
      readSelection: () => SelectionReading;
      selectPlaceholder: (portion: StoredPortion) => Promise<void>;
      // Reads which portion's placeholder holds the selection, at each change
      // of the selection, where the editor tells it through no event of its
      // own; null where it does.
      readActivePortion: (() => Promise<string | null>) | null;
      // Whether the editor puts its own settings in the panel's place once the
      // document is loaded.
      hidesPanelOnLoad: boolean;
      insertionHint: string;
    }
  >
> = {
  word: {
    packageKind: 'text-document',
    read: readDocumentCommand,
    write: writeLabellingCommand,
    pageMarkingOf: (snapshot) => textPageMarkingOf(snapshot.headersAndFooters),
    insertsPortions: true,
    editsPortions: true,
    readSelection: readParagraphsCommand,
    selectPlaceholder: async (portion) => {
      await callEditorMethod('SelectContentControl', [portion.internalId]);
    },
    readActivePortion: null,
    hidesPanelOnLoad: false,
    insertionHint: messages.insertionHint,
  },
  cell: {
    packageKind: 'workbook',
    read: readWorkbookCommand,
    write: writeWorkbookLabellingCommand,
    pageMarkingOf: (snapshot) => sheetPageMarkingOf(snapshot.sheets),
    insertsPortions: true,
    editsPortions: true,
    readSelection: readSelectionCommand,
    selectPlaceholder: async (portion) => {
      const scope = { rangeTitle: portion.id } satisfies SelectionScope;
      const selected = await runCommand(selectPlaceholderCommand, scope, false, (result) => (typeof result === 'boolean' ? result : null));
      if (selected !== true) {
        throw new Error('No sheet holds the portion\'s placeholder');
      }
    },
    readActivePortion: async () => runCommand(placeholderAtActiveCellCommand, {}, false, (result) => (typeof result === 'string' ? result : null)),
    // The spreadsheet editor shows the cell settings at the first selection
    // after its side menu opened, once the panel had opened it: often as the
    // workbook loads, always once the browser remembers the menu open.
    hidesPanelOnLoad: true,
    insertionHint: messages.cellInsertionHint,
  },
};

// Every change of a portion sends its whole part through co-editing, twice:
// a bounded text keeps it far below the Document Server's message limit.
export const PORTION_TEXT_LIMIT = 20_000;

// Characters count, not UTF-16 code units: an emoji counts once.
export function exceedsPortionTextLimit(text: string): boolean {
  return Array.from(text).length > PORTION_TEXT_LIMIT;
}

export const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
export const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';

export interface PortionTag {
  v: 1;
  id: string;
  label: string;
}

// The page marking's content controls name the document label they show.
export interface PageMarkingTag {
  v: 1;
  kind: 'page-marking';
  label: string;
}

// What a portion's part holds: an envelope, base64 as stored, or the text of
// an unencrypted portion, written before encryption existed.
export type PortionContent = { encoding: 'ztdf'; envelope: string } | { encoding: 'base64'; text: string | null };

export interface StoredPortion {
  id: string;
  // The label in clear: the code in the content control's tag, or in a
  // workbook in the part, and the code and ADatP-4774 XML in the portion's
  // part, null without a part.
  labelCode: string;
  partLabelCode: string | null;
  partLabelXml: string | null;
  version: number | null;
  // null when the part is missing or unreadable.
  content: PortionContent | null;
  // The editor's handle on its placeholder: a content control's internal id,
  // or the reference of a workbook's range.
  internalId: string;
}

export interface DocumentState {
  portions: StoredPortion[];
  baseLabelCode: string | null;
  // Code of the document label last written with the ADatP-4778.2 part.
  documentLabelCode: string | null;
  // What the page marking shows in every header and footer, each holding one
  // page marking in its place; null when one of them does not.
  pageMarking: ShownPageMarking | null;
  // Whether the author types in a cell of a workbook, meanwhile the panel
  // writes nothing.
  cellBeingEdited: boolean;
}

// A text document's page marking names its label in its tag, and its colour
// is the label's; a workbook's shows the text and the colour only.
export interface ShownPageMarking {
  labelCode: string | null;
  text: string;
  color: string | null;
}

export interface NewPortion {
  label: LabelView;
  text: string;
}

// Selected content to protect as a new portion, under a label.
export interface SelectionToProtect {
  label: LabelView;
  content: SelectedContent;
}

// What writing a new portion gave, with the portion's id and first state.
export interface NewPortionWrite {
  portionId: string;
  state: PortionState;
  result: WriteResult;
}

// The document's other labels: its base label and the labels of its other
// portions, from which, with a written portion's label, the document label
// is computed.
export interface OtherLabels {
  baseLabelCode: string;
  portionLabelCodes: string[];
}

interface PortionPartContent {
  id: string;
  version: number;
  labelCode: string;
  labelXml: string | null;
  content: PortionContent | null;
}

// What writing a portion's text gave: nothing reaches the document when its
// text cannot be encrypted, nor when the portion changed since its change
// started.
export type WriteResult =
  | { status: 'written' }
  | { status: 'not-encrypted'; reason: string }
  | { status: 'changed-meanwhile' }
  | { status: 'cells-occupied' }
  | { status: 'selection-changed' }
  | { status: 'cell-being-edited' }
  | { status: 'not-written' };

// A new text for a portion the author holds the lock of, under the label it
// keeps or a new one.
export interface PortionChange {
  portion: StoredPortion;
  label: LabelView;
  text: string;
}

// The text is sealed before anything reaches the document: a text that cannot
// be encrypted is not inserted.
export async function insertPortion(portion: NewPortion, others: OtherLabels, envelopes: EnvelopeClient, editor: EditorType): Promise<WriteResult> {
  const { result } = await writeNewPortion(portion, others, envelopes, editor, (fields) => ({ kind: 'insertion', ...fields }));
  return result;
}

// The new text is sealed before anything reaches the document: a text that
// cannot be encrypted changes nothing. Under a new label, the placeholder,
// the document label and the page marking change with it.
export async function changePortion(change: PortionChange, others: OtherLabels, envelopes: EnvelopeClient, editor: EditorType): Promise<WriteResult> {
  const { label, portion } = change;
  const sealed = await sealPortion(label, change.text, others, envelopes, editor);
  if (sealed.status === 'not-encrypted') {
    return sealed;
  }
  const xml = buildPortionPart({ id: portion.id, version: nextVersion(portion), labelCode: label.code, labelXml: sealed.labelXml, envelope: sealed.envelope });
  return writeLabelling({ kind: 'change', id: portion.id, block: portionBlockScope(portion.id, label), xml }, sealed.documentLabel, others, editor);
}

// Reads the selected content the panel protects, or why it refuses it; null
// when the editor did not answer as expected.
export async function readSelection(editor: EditorType): Promise<SelectionReading | null> {
  const command = EDITORS[editor].readSelection;
  // Each cell but the first adds a separator to the text: more cells than a
  // portion's text holds characters would not fit.
  const scope = { cellLimit: PORTION_TEXT_LIMIT } satisfies SelectionReadingScope;
  const reading = await runCommand(command, scope, false, parseSelectionReading);
  return reading?.status === 'read' && exceedsPortionTextLimit(textOfSelection(reading.content)) ? { status: 'refused', reason: 'too-large' } : reading;
}

// The text of selected content, as its portion holds it. Paragraphs are
// separated by line breaks. Cells go in rows separated by tabs, as a copy
// from the grid gives them, and as spreadsheets read them back: a cell that
// holds a tab, a line break or a quote is quoted, its quotes doubled.
export function textOfSelection(content: SelectedContent): string {
  if (content.kind === 'paragraphs') {
    return content.texts.join('\n');
  }
  const field = (value: string): string => (/[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return content.texts.map((row) => row.map(field).join('\t')).join('\n');
}

// The selected content is sealed under the label as the text of a new
// portion, whose placeholder takes its place: nothing reaches the document
// when it cannot be encrypted, nor when the content changed since the panel
// read it. The content went through ONLYOFFICE in clear before: the panel
// warned the author before they confirmed.
export async function protectSelection(
  protection: SelectionToProtect,
  others: OtherLabels,
  envelopes: EnvelopeClient,
  editor: EditorType,
): Promise<NewPortionWrite> {
  const { label, content } = protection;
  return writeNewPortion({ label, text: textOfSelection(content) }, others, envelopes, editor, (fields) => ({ kind: 'protection', content, ...fields }));
}

// A new portion's first version, which `placed` puts where it goes.
async function writeNewPortion(
  portion: NewPortion,
  others: OtherLabels,
  envelopes: EnvelopeClient,
  editor: EditorType,
  placed: (fields: { id: string; alias: string; block: PortionBlockScope; xml: string }) => PortionWriteScope,
): Promise<NewPortionWrite> {
  const portionId = crypto.randomUUID();
  const state = { label: portion.label.code, version: 1 };
  const sealed = await sealPortion(portion.label, portion.text, others, envelopes, editor);
  if (sealed.status === 'not-encrypted') {
    return { portionId, state, result: sealed };
  }
  const xml = buildPortionPart({ id: portionId, version: state.version, labelCode: state.label, labelXml: sealed.labelXml, envelope: sealed.envelope });
  const scope = placed({ id: portionId, alias: messages.portionAlias, block: portionBlockScope(portionId, portion.label), xml });
  return { portionId, state, result: await writeLabelling(scope, sealed.documentLabel, others, editor) };
}

// The document label that a request gives, with a binding over the parts of
// the format the editor edits.
export async function documentLabelIn(editor: EditorType, request: DocumentLabelRequest): Promise<DocumentLabel> {
  return fetchDocumentLabel(request, EDITORS[editor].packageKind);
}

// Deletes a portion and its part, with the document label and the page
// marking that the document's other labels give.
export async function deletePortion(portion: StoredPortion, policy: string, others: OtherLabels, editor: EditorType): Promise<WriteResult> {
  const documentLabel = await documentLabelIn(editor, { policy, ...others });
  return writeLabelling({ kind: 'deletion', id: portion.id }, documentLabel, others, editor);
}

// The version a change of the portion writes.
export function nextVersion(portion: StoredPortion): number {
  return (portion.version ?? 1) + 1;
}

type SealedPortion =
  | { status: 'sealed'; labelXml: string; envelope: Uint8Array; documentLabel: DocumentLabel }
  | { status: 'not-encrypted'; reason: string };

// Seals a portion's text under its label, and computes the document label
// that the portion's label gives the document.
async function sealPortion(label: LabelView, text: string, others: OtherLabels, envelopes: EnvelopeClient, editor: EditorType): Promise<SealedPortion> {
  const [labelXml, attributes, documentLabel] = await Promise.all([
    fetchAdatp4774(label.policy, label.code),
    fetchLabelAttributes(label.policy, label.code),
    documentLabelIn(editor, { policy: label.policy, baseLabelCode: others.baseLabelCode, portionLabelCodes: [...others.portionLabelCodes, label.code] }),
  ]);
  const sealed = await envelopes.seal(text, { xml: labelXml, attributes });
  return sealed.status === 'failed' ? { status: 'not-encrypted', reason: sealed.reason } : { status: 'sealed', labelXml, envelope: sealed.envelope, documentLabel };
}

function portionBlockScope(id: string, label: LabelView): PortionBlockScope {
  const tag: PortionTag = { v: 1, id, label: label.code };
  return { tag: JSON.stringify(tag), color: label.marking.color, placeholder: messages.portionPlaceholder(label.marking.text) };
}

async function writeLabelling(portion: PortionWriteScope, documentLabel: DocumentLabel, others: OtherLabels, editor: EditorType): Promise<WriteResult> {
  const written = await runCommand(
    EDITORS[editor].write,
    { portion, portionNamespace: PORTION_NAMESPACE, ...documentLabelScope(documentLabel, others.baseLabelCode) },
    true,
    parseWriteOutcome,
  );
  return written === null ? { status: 'not-written' } : { status: written };
}

const WRITE_OUTCOMES = ['written', 'not-written', 'cells-occupied', 'selection-changed', 'cell-being-edited'] as const satisfies readonly WriteOutcome[];

function parseWriteOutcome(result: unknown): WriteOutcome | null {
  return WRITE_OUTCOMES.find((outcome) => outcome === result) ?? null;
}

// Rewrites the document label and its page marking from the base label and
// the portions' labels.
export async function writeDocumentLabel(request: DocumentLabelRequest, editor: EditorType): Promise<WriteOutcome> {
  const documentLabel = await documentLabelIn(editor, request);
  const done = await runCommand(
    EDITORS[editor].write,
    { portion: null, ...documentLabelScope(documentLabel, request.baseLabelCode) },
    true,
    parseWriteOutcome,
  );
  return done ?? 'not-written';
}

// Portions in document order, each joined with the content of its part. A
// text document's portion is its placeholder, whose tag holds its label; a
// workbook's counts when both its placeholder, a user protected range titled
// with its id, and its part, which holds its label, are there (ADR 0006).
export async function readDocumentState(editor: EditorType): Promise<DocumentState> {
  const snapshot = await runCommand(
    EDITORS[editor].read,
    { portionNamespace: PORTION_NAMESPACE, documentNamespace: DOCUMENT_NAMESPACE },
    false,
    parseSnapshot,
  );
  if (snapshot === null) {
    return { portions: [], baseLabelCode: null, documentLabelCode: null, pageMarking: null, cellBeingEdited: false };
  }
  const contents = new Map<string, PortionPartContent>();
  for (const xml of snapshot.portionParts) {
    const content = parsePortionPart(xml);
    if (content !== null) {
      contents.set(content.id, content);
    }
  }
  const placeholders = [
    ...snapshot.controls.flatMap((control) => {
      const tag = parsePortionTag(control.tag);
      return tag === null ? [] : [{ id: tag.id, labelCode: tag.label, internalId: control.internalId }];
    }),
    ...snapshot.ranges.flatMap((range) => {
      const labelCode = contents.get(range.title)?.labelCode ?? null;
      return labelCode === null ? [] : [{ id: range.title, labelCode, internalId: range.reference }];
    }),
  ];
  const portions = placeholders.map(({ id, labelCode, internalId }) => {
    const content = contents.get(id) ?? null;
    return {
      id,
      labelCode,
      partLabelCode: content?.labelCode ?? null,
      partLabelXml: content?.labelXml ?? null,
      version: content?.version ?? null,
      content: content?.content ?? null,
      internalId,
    };
  });
  const documentPart = snapshot.documentParts.map(parseDocumentPart).find((part) => part !== null) ?? null;
  return {
    portions,
    baseLabelCode: documentPart?.base ?? null,
    documentLabelCode: documentPart?.label ?? null,
    pageMarking: EDITORS[editor].pageMarkingOf(snapshot),
    cellBeingEdited: snapshot.cellBeingEdited,
  };
}

// The standard ADatP-4778.2 part holds the document label; the project's own
// part keeps the base label the author chose. The page marking shows the
// document label's marking in its colour.
function documentLabelScope(documentLabel: DocumentLabel, baseLabelCode: string): DocumentLabelScope {
  const { label } = documentLabel;
  const tag: PageMarkingTag = { v: 1, kind: 'page-marking', label: label.code };
  return {
    replacements: [
      { namespace: BINDING_NAMESPACE, xml: documentLabel.xml },
      { namespace: DOCUMENT_NAMESPACE, xml: buildDocumentPart(baseLabelCode, label.code) },
    ],
    pageMarking: {
      tag: JSON.stringify(tag),
      alias: messages.pageMarkingAlias,
      text: label.marking.text,
      color: label.marking.color,
      headerFooterCentre: `${HEADER_FOOTER_MARKING_CODES}${markingColorOf(label).slice(1)}${label.marking.text.replaceAll('&', '&&')}`,
    },
  };
}

// A workbook's page marking, in a header or footer string's centre section:
// bold, then the colour, as RRGGBB, then the marking, whose ampersands are
// doubled.
const HEADER_FOOTER_MARKING_CODES = '&"-,Bold"&K';
const HEADER_FOOTER_MARKING = /^&"-,Bold"&K([0-9A-Fa-f]{6})((?:[^&]|&&)*)$/;

// The colour of a label's marking, as a workbook's header shows it: black
// for a label without one.
function markingColorOf(label: LabelView): string {
  return (label.marking.color ?? '#000000').toUpperCase();
}

// Whether the document shows the page marking of a label: a text document's
// names the label in its tag, a workbook's shows its text in its colour.
export function showsPageMarkingOf(shown: ShownPageMarking | null, label: LabelView): boolean {
  return (
    shown !== null &&
    (shown.labelCode === null || shown.labelCode === label.code) &&
    shown.text === label.marking.text &&
    (shown.color === null || shown.color === markingColorOf(label))
  );
}

// What every header and footer shows, each in one locked page marking in its
// place; null when one of them does not.
function textPageMarkingOf(headersAndFooters: HeaderFooterSnapshot[]): ShownPageMarking | null {
  const shown = headersAndFooters.map(({ kind, blocks }): ShownPageMarking | null => {
    if (blocks === null) {
      return null;
    }
    const [marking, ...others] = blocks.flatMap((block, position) => {
      const tag = block === null ? null : parsePageMarkingTag(block.tag);
      return block === null || tag === null ? [] : [{ position, block, labelCode: tag.label }];
    });
    const place = kind === 'header' ? 0 : blocks.length - 1;
    if (marking === undefined || others.length > 0 || marking.position !== place || marking.block.lock !== 'sdtContentLocked' || marking.block.text === null) {
      return null;
    }
    return { labelCode: marking.labelCode, text: marking.block.text, color: null };
  });
  const [first] = shown;
  return first !== undefined && first !== null && shown.every((one) => one?.labelCode === first.labelCode && one.text === first.text) ? first : null;
}

// What every sheet's six headers and footers show in their centre section,
// with the flags that make even and first pages use their own: the page
// marking, bold and in its label's colour; null when one of them does not.
function sheetPageMarkingOf(sheets: SheetSnapshot[]): ShownPageMarking | null {
  const centres = sheets.flatMap((sheet) => (sheet.differentFirst && sheet.differentOddEven ? sheet.centres : [null]));
  const [first] = centres;
  const match = first === undefined || first === null ? null : HEADER_FOOTER_MARKING.exec(first);
  if (match === null || centres.some((centre) => centre !== first)) {
    return null;
  }
  return { labelCode: null, text: (match[2] ?? '').replaceAll('&&', '&'), color: `#${(match[1] ?? '').toUpperCase()}` };
}

// The envelope, a ZTDF archive, is stored base64-encoded. The portion label
// stays readable next to it.
export function buildPortionPart(portion: {
  id: string;
  version: number;
  labelCode: string;
  labelXml: string;
  envelope: Uint8Array;
}): string {
  return (
    `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${portion.id}" version="${portion.version}" label="${escapeAttribute(portion.labelCode)}">` +
    `<dcs:label>${portion.labelXml}</dcs:label>` +
    `<dcs:content encoding="ztdf">${base64OfBytes(portion.envelope)}</dcs:content>` +
    '</dcs:portion>'
  );
}

function buildDocumentPart(baseLabelCode: string, documentLabelCode: string): string {
  return `<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="${escapeAttribute(baseLabelCode)}" label="${escapeAttribute(documentLabelCode)}"/>`;
}

export function parsePortionTag(tag: string): PortionTag | null {
  const parsed = parseTag(tag);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'v' in parsed &&
    parsed.v === 1 &&
    'id' in parsed &&
    typeof parsed.id === 'string' &&
    'label' in parsed &&
    typeof parsed.label === 'string'
  ) {
    return { v: 1, id: parsed.id, label: parsed.label };
  }
  return null;
}

function parsePageMarkingTag(tag: string): PageMarkingTag | null {
  const parsed = parseTag(tag);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'v' in parsed &&
    parsed.v === 1 &&
    'kind' in parsed &&
    parsed.kind === 'page-marking' &&
    'label' in parsed &&
    typeof parsed.label === 'string'
  ) {
    return { v: 1, kind: 'page-marking', label: parsed.label };
  }
  return null;
}

// The plugin's tags are JSON; other tools' tags may be anything.
function parseTag(tag: string): unknown {
  try {
    const parsed: unknown = JSON.parse(tag);
    return parsed;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function parsePortionPart(xml: string): PortionPartContent | null {
  const root = parseXml(xml);
  if (root === null || root.namespaceURI !== PORTION_NAMESPACE || root.localName !== 'portion') {
    return null;
  }
  const id = root.getAttribute('id');
  const labelCode = root.getAttribute('label');
  const version = Number(root.getAttribute('version'));
  if (id === null || labelCode === null || !Number.isInteger(version)) {
    return null;
  }
  const content = root.getElementsByTagNameNS(PORTION_NAMESPACE, 'content')[0];
  const label = root.getElementsByTagNameNS(PORTION_NAMESPACE, 'label')[0]?.firstElementChild ?? null;
  return {
    id,
    version,
    labelCode,
    labelXml: label === null ? null : new XMLSerializer().serializeToString(label),
    content: content === undefined ? null : contentOf(content),
  };
}

// Unencrypted portions store their text base64-encoded, since the editor's
// XML serialiser does not escape `&`, `<` or quotes in text reliably.
function contentOf(element: Element): PortionContent | null {
  const stored = (element.textContent ?? '').trim();
  switch (element.getAttribute('encoding')) {
    case 'ztdf':
      return { encoding: 'ztdf', envelope: stored };
    case 'base64':
      return { encoding: 'base64', text: decodeBase64(stored) };
    default:
      return null;
  }
}

function parseDocumentPart(xml: string): { base: string | null; label: string | null } | null {
  const root = parseXml(xml);
  if (root === null || root.namespaceURI !== DOCUMENT_NAMESPACE || root.localName !== 'document') {
    return null;
  }
  return { base: root.getAttribute('base'), label: root.getAttribute('label') };
}

function parseXml(xml: string): Element | null {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  return document.getElementsByTagName('parsererror').length > 0 ? null : document.documentElement;
}

function parseSnapshot(result: unknown): DocumentSnapshot | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const { controls, ranges, portionParts, documentParts, headersAndFooters, sheets, cellBeingEdited } = result as Record<string, unknown>; // SAFETY: object checked above
  if (
    !Array.isArray(controls) ||
    !Array.isArray(ranges) ||
    !Array.isArray(portionParts) ||
    !Array.isArray(documentParts) ||
    !Array.isArray(headersAndFooters) ||
    !Array.isArray(sheets)
  ) {
    return null;
  }
  const isString = (value: unknown): value is string => typeof value === 'string';
  return {
    controls: controls.filter(
      (control): control is { tag: string; internalId: string } =>
        typeof control === 'object' &&
        control !== null &&
        'tag' in control &&
        typeof control.tag === 'string' &&
        'internalId' in control &&
        typeof control.internalId === 'string',
    ),
    ranges: ranges.filter(
      (range): range is { title: string; reference: string } =>
        typeof range === 'object' &&
        range !== null &&
        'title' in range &&
        typeof range.title === 'string' &&
        'reference' in range &&
        typeof range.reference === 'string',
    ),
    portionParts: portionParts.filter(isString),
    documentParts: documentParts.filter(isString),
    headersAndFooters: headersAndFooters.map(parseHeaderFooter),
    sheets: sheets.map(parseSheet),
    cellBeingEdited: cellBeingEdited === true,
  };
}

const SELECTION_REFUSALS = [
  'cell-being-edited',
  'several-areas',
  'too-large',
  'merge-portion-or-table',
  'commented-cells',
  'formula',
  'empty-cells',
  'outside-body',
  'table',
  'drawing',
  'content-control',
  'commented-paragraphs',
  'noted-paragraphs',
  'empty-paragraphs',
] as const satisfies readonly SelectionRefusal[];

function parseSelectionReading(result: unknown): SelectionReading | null {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return null;
  }
  if (result.status === 'refused') {
    const reason = SELECTION_REFUSALS.find((refusal) => 'reason' in result && result.reason === refusal);
    return reason === undefined ? null : { status: 'refused', reason };
  }
  if (result.status !== 'read' || !('content' in result) || typeof result.content !== 'object' || result.content === null) {
    return null;
  }
  const { kind, sheet, address, position, texts } = result.content as Record<string, unknown>; // SAFETY: object checked above
  const isTexts = (values: unknown): values is string[] => Array.isArray(values) && values.every((value) => typeof value === 'string');
  if (kind === 'paragraphs') {
    return typeof position === 'number' && Number.isInteger(position) && isTexts(texts) ? { status: 'read', content: { kind, position, texts } } : null;
  }
  return kind === 'cells' && typeof sheet === 'string' && typeof address === 'string' && Array.isArray(texts) && texts.every(isTexts)
    ? { status: 'read', content: { kind, sheet, address, texts } }
    : null;
}

// A sheet the editor did not answer as expected counts as one without the
// page marking.
function parseSheet(value: unknown): SheetSnapshot {
  if (typeof value !== 'object' || value === null || !('centres' in value) || !Array.isArray(value.centres)) {
    return { centres: [null], differentFirst: false, differentOddEven: false };
  }
  return {
    centres: value.centres.map((centre: unknown) => (typeof centre === 'string' ? centre : null)),
    differentFirst: 'differentFirst' in value && value.differentFirst === true,
    differentOddEven: 'differentOddEven' in value && value.differentOddEven === true,
  };
}

// An entry the editor did not answer as expected counts as a missing header.
function parseHeaderFooter(value: unknown): HeaderFooterSnapshot {
  if (typeof value !== 'object' || value === null || !('kind' in value) || (value.kind !== 'header' && value.kind !== 'footer') || !('blocks' in value)) {
    return { kind: 'header', blocks: null };
  }
  return { kind: value.kind, blocks: Array.isArray(value.blocks) ? value.blocks.map(parseControl) : null };
}

function parseControl(value: unknown): ControlSnapshot | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tag' in value) ||
    typeof value.tag !== 'string' ||
    !('lock' in value) ||
    typeof value.lock !== 'string' ||
    !('text' in value)
  ) {
    return null;
  }
  return { tag: value.tag, lock: value.lock, text: typeof value.text === 'string' ? value.text : null };
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

// An envelope as stored, or null when it is not valid base64.
export function envelopeBytes(stored: string): Uint8Array | null {
  try {
    return bytesOfBase64(stored);
  } catch (error: unknown) {
    if (error instanceof DOMException) {
      return null;
    }
    throw error;
  }
}

function bytesOfBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeBase64(encoded: string): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytesOfBase64(encoded));
  } catch (error: unknown) {
    if (error instanceof DOMException || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
