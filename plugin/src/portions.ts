import type { EnvelopeClient } from './envelopes.ts';
import { messages } from './messages.ts';
import type {
  ApiBlockLvlSdt,
  ApiContentControl,
  ApiCustomXmlPart,
  ApiDocumentContent,
  ApiDocumentElement,
  ApiParagraph,
  ApiSection,
  HeaderFooterType,
  OfficeApi,
} from './office-api.ts';
import { runCommand } from './onlyoffice.ts';
import { type DocumentLabel, type DocumentLabelRequest, fetchAdatp4774, fetchDocumentLabel, fetchLabelAttributes, type LabelView } from './policy.ts';

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
  // The label in clear: the code in the content control's tag, and the code
  // and ADatP-4774 XML in the portion's part, null without a part.
  labelCode: string;
  partLabelCode: string | null;
  partLabelXml: string | null;
  version: number | null;
  // null when the part is missing or unreadable.
  content: PortionContent | null;
  internalId: string;
}

export interface DocumentState {
  portions: StoredPortion[];
  baseLabelCode: string | null;
  // Code of the document label last written with the ADatP-4778.2 part.
  documentLabelCode: string | null;
  // What the page marking shows in every header and footer, each holding one
  // locked page marking in its place; null when one of them does not.
  pageMarking: ShownPageMarking | null;
}

export interface ShownPageMarking {
  labelCode: string;
  text: string;
}

export interface NewPortion {
  label: LabelView;
  text: string;
}

// The document's other labels: its base label and the labels of its other
// portions, from which, with a written portion's label, the document label
// is computed.
export interface OtherLabels {
  baseLabelCode: string;
  portionLabelCodes: string[];
}

interface PartReplacement {
  namespace: string;
  xml: string;
}

// What a portion's placeholder block shows of its label.
interface PortionBlockScope {
  tag: string;
  color: string | null;
  placeholder: string;
}

// A portion the command writes, with its part: a new one, or a new version
// of one the document holds; or one it deletes.
type PortionWriteScope =
  | { kind: 'insertion'; alias: string; block: PortionBlockScope; xml: string }
  | { kind: 'change'; id: string; block: PortionBlockScope; xml: string }
  | { kind: 'deletion'; id: string };

interface PageMarkingScope {
  tag: string;
  alias: string;
  text: string;
  color: string | null;
}

// What writing the document label writes: its parts and its page marking.
interface DocumentLabelScope {
  replacements: PartReplacement[];
  pageMarking: PageMarkingScope;
}

interface CommandScope extends DocumentLabelScope {
  portion: PortionWriteScope | null;
  portionNamespace: string;
  documentNamespace: string;
}

type HeaderFooterKind = 'header' | 'footer';

// A block content control of a header or a footer, as far as the page marking
// goes: its text is null unless it holds a single paragraph.
interface ControlSnapshot {
  tag: string;
  lock: string;
  text: string | null;
}

// A header or a footer that must hold the page marking: its blocks, null for
// those that are not content controls; null when it is missing.
interface HeaderFooterSnapshot {
  kind: HeaderFooterKind;
  blocks: (ControlSnapshot | null)[] | null;
}

interface DocumentSnapshot {
  controls: { tag: string; internalId: string }[];
  portionParts: string[];
  documentParts: string[];
  headersAndFooters: HeaderFooterSnapshot[];
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
  | { status: 'not-written' };

// A new text for a portion the author holds the lock of, under the label it
// keeps or a new one.
export interface PortionChange {
  portion: StoredPortion;
  label: LabelView;
  text: string;
}

declare const Api: OfficeApi;
declare const Asc: { scope: CommandScope };

// One command writes a new portion, a portion's change or its deletion, if
// there is one, with the document label and its page marking, so that a
// single undo reverts all of them. False when the portion to change or delete
// is gone.
function writeLabellingCommand(): boolean {
  const scope = Asc.scope;
  const document = Api.GetDocument();
  const parts = document.GetCustomXmlParts();

  const isParagraph = (element: ApiDocumentElement | null): element is ApiParagraph => element?.GetClassType() === 'paragraph';
  const isBlock = (element: ApiDocumentElement | ApiContentControl | null): element is ApiBlockLvlSdt => element?.GetClassType() === 'blockLvlSdt';
  // The plugin's tags are JSON; other tools' tags may be anything.
  const parsedTag = (tag: string): unknown => {
    try {
      const parsed: unknown = JSON.parse(tag);
      return parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  };

  // A block of the plugin's own, locked only once `fill` has set its content.
  const lockedBlock = (tag: string, alias: string, fill: (paragraph: ApiParagraph | null, block: ApiBlockLvlSdt) => void): ApiBlockLvlSdt => {
    const block = Api.CreateBlockLvlSdt();
    block.SetTag(tag);
    block.SetAlias(alias);
    const first = block.GetContent().GetElement(0);
    fill(isParagraph(first) ? first : null, block);
    block.SetLock('sdtContentLocked');
    return block;
  };

  const showPortionLabel = (paragraph: ApiParagraph | null, control: ApiBlockLvlSdt, block: PortionBlockScope): void => {
    if (block.color !== null) {
      control.SetBorderColor(Api.HexColor(block.color));
    }
    paragraph?.RemoveAllElements();
    paragraph?.AddText(block.placeholder);
  };

  const insertPortionBlock = (portion: Extract<PortionWriteScope, { kind: 'insertion' }>): void => {
    const block = lockedBlock(portion.block.tag, portion.alias, (paragraph, control) => {
      showPortionLabel(paragraph, control, portion.block);
    });
    // Inserting at the cursor would split the paragraph that holds it. When
    // that paragraph has text and sits in the document body, the block goes
    // right after it; elsewhere (an empty paragraph, a table, a header) it
    // goes at the cursor, as the editor does.
    const paragraph = document.GetCurrentParagraph();
    const position = paragraph === null ? -1 : paragraph.GetPosInParent();
    const inBody = paragraph !== null && document.GetElement(position)?.GetInternalId() === paragraph.GetInternalId();
    if (inBody && paragraph.GetText().trim() !== '') {
      document.AddElement(position + 1, block);
    } else {
      document.InsertContent([block]);
    }
    parts.Add(portion.xml);
  };

  // A portion's part, found by the portion id its root element names, however
  // the editor serialises it, and its placeholder block, found by the portion
  // id in its tag; null unless the document holds both.
  const portionInDocument = (id: string): { portionParts: ApiCustomXmlPart[]; placeholders: ApiBlockLvlSdt[] } | null => {
    const portionParts = parts
      .GetByNamespace(scope.portionNamespace)
      .filter((part) => /<(?:[\w-]+:)?portion\b[^>]*?\sid=["']([^"']*)["']/.exec(part.GetXml())?.[1] === id);
    const placeholders = document.GetAllContentControls().filter((control): control is ApiBlockLvlSdt => {
      const tag = isBlock(control) ? parsedTag(control.GetTag()) : null;
      return typeof tag === 'object' && tag !== null && 'id' in tag && tag.id === id;
    });
    return portionParts.length === 0 || placeholders.length === 0 ? null : { portionParts, placeholders };
  };

  // The portion's part is replaced with its new version, and its placeholder
  // block shows its label.
  const changePortionBlock = (change: Extract<PortionWriteScope, { kind: 'change' }>): boolean => {
    const portion = portionInDocument(change.id);
    if (portion === null) {
      return false;
    }
    for (const part of portion.portionParts) {
      part.Delete();
    }
    parts.Add(change.xml);
    for (const control of portion.placeholders) {
      control.SetLock('unlocked');
      control.SetTag(change.block.tag);
      const first = control.GetContent().GetElement(0);
      showPortionLabel(isParagraph(first) ? first : null, control, change.block);
      control.SetLock('sdtContentLocked');
    }
    return true;
  };

  // The portion's placeholder block goes, unlocked first since the editor
  // refuses to delete a locked one, then its part. Should the editor refuse
  // all the same, the part stays and nothing counts as deleted.
  const deletePortionBlock = (deletion: Extract<PortionWriteScope, { kind: 'deletion' }>): boolean => {
    const portion = portionInDocument(deletion.id);
    if (portion === null) {
      return false;
    }
    const deleted = portion.placeholders.map((control) => {
      control.SetLock('unlocked');
      return control.Delete(false);
    });
    if (deleted.includes(false)) {
      return false;
    }
    for (const part of portion.portionParts) {
      part.Delete();
    }
    return true;
  };

  // The page marking is the first block of a header and the last of a
  // footer, where readDocumentCommand looks for it. The one this command
  // writes, already in place, locked and unchanged, stays, so that authors
  // writing the same one at once do not end up with two; any other goes.
  const marking = scope.pageMarking;
  const isPageMarking = (element: ApiDocumentElement | null): boolean => {
    const tag = isBlock(element) ? parsedTag(element.GetTag()) : null;
    return typeof tag === 'object' && tag !== null && 'kind' in tag && tag.kind === 'page-marking';
  };
  const isWrittenMarking = (element: ApiDocumentElement | null): boolean => {
    if (!isBlock(element) || element.GetTag() !== marking.tag || element.GetLock() !== 'sdtContentLocked') {
      return false;
    }
    const content = element.GetContent();
    const paragraph = content.GetElement(0);
    return content.GetElementsCount() === 1 && isParagraph(paragraph) && paragraph.GetText().trim() === marking.text;
  };
  const markPage = (content: ApiDocumentContent, kind: HeaderFooterKind, created: boolean): void => {
    const place = (): number => (kind === 'header' ? 0 : content.GetElementsCount() - 1);
    let kept = !created && isWrittenMarking(content.GetElement(place())) ? place() : -1;
    if (kept === -1) {
      const block = lockedBlock(marking.tag, marking.alias, (paragraph) => {
        paragraph?.SetJc('center');
        const text = paragraph?.AddText(marking.text);
        text?.SetBold(true);
        if (marking.color !== null) {
          text?.SetColor(Api.HexColor(marking.color));
        }
      });
      if (kind === 'header') {
        content.AddElement(0, block);
      } else {
        content.Push(block);
      }
      // A header or a footer comes with an empty paragraph.
      if (created) {
        content.RemoveElement(kind === 'header' ? 1 : 0);
      }
      kept = place();
    }
    for (let position = content.GetElementsCount() - 1; position >= 0; position -= 1) {
      if (position !== kept && isPageMarking(content.GetElement(position))) {
        content.RemoveElement(position);
      }
    }
  };
  const headerFooterOf = (section: ApiSection, type: HeaderFooterType, kind: HeaderFooterKind, create: boolean): ApiDocumentContent | null =>
    kind === 'header' ? section.GetHeader(type, create) : section.GetFooter(type, create);

  if (scope.portion?.kind === 'insertion') {
    insertPortionBlock(scope.portion);
  }
  if (scope.portion?.kind === 'change' && !changePortionBlock(scope.portion)) {
    return false;
  }
  if (scope.portion?.kind === 'deletion' && !deletePortionBlock(scope.portion)) {
    return false;
  }
  for (const replacement of scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  // Every kind of header and footer: the default ones, the first page's and
  // the even pages'. A later section without one of its own shows the
  // previous section's, so only the first section gets the missing ones.
  for (const [index, section] of document.GetSections().entries()) {
    for (const type of ['default', 'title', 'even'] as const) {
      for (const kind of ['header', 'footer'] as const) {
        const own = headerFooterOf(section, type, kind, false);
        const content = own ?? (index === 0 ? headerFooterOf(section, type, kind, true) : null);
        if (content !== null) {
          markPage(content, kind, own === null);
        }
      }
    }
  }
  return true;
}

function readDocumentCommand(): DocumentSnapshot {
  const document = Api.GetDocument();
  const parts = document.GetCustomXmlParts();
  const isParagraph = (element: ApiDocumentElement | null): element is ApiParagraph => element?.GetClassType() === 'paragraph';
  const isBlock = (element: ApiDocumentElement | null): element is ApiBlockLvlSdt => element?.GetClassType() === 'blockLvlSdt';
  const controlOf = (element: ApiDocumentElement | null): ControlSnapshot | null => {
    if (!isBlock(element)) {
      return null;
    }
    const content = element.GetContent();
    const paragraph = content.GetElement(0);
    const text = content.GetElementsCount() === 1 && isParagraph(paragraph) ? paragraph.GetText().trim() : null;
    return { tag: element.GetTag(), lock: element.GetLock(), text };
  };
  // The headers and footers the page marking must be in, as
  // writeLabellingCommand finds them.
  const headersAndFooters: HeaderFooterSnapshot[] = [];
  for (const [index, section] of document.GetSections().entries()) {
    for (const type of ['default', 'title', 'even'] as const) {
      for (const kind of ['header', 'footer'] as const) {
        const content = kind === 'header' ? section.GetHeader(type, false) : section.GetFooter(type, false);
        if (content === null && index > 0) {
          continue;
        }
        const blocks: (ControlSnapshot | null)[] = [];
        for (let position = 0; content !== null && position < content.GetElementsCount(); position += 1) {
          blocks.push(controlOf(content.GetElement(position)));
        }
        headersAndFooters.push({ kind, blocks: content === null ? null : blocks });
      }
    }
  }
  return {
    controls: document.GetAllContentControls().map((control) => ({
      tag: control.GetTag(),
      internalId: control.GetInternalId(),
    })),
    portionParts: parts.GetByNamespace(Asc.scope.portionNamespace).map((part) => part.GetXml()),
    documentParts: parts.GetByNamespace(Asc.scope.documentNamespace).map((part) => part.GetXml()),
    headersAndFooters,
  };
}

// The text is sealed before anything reaches the document: a text that cannot
// be encrypted is not inserted.
export async function insertPortion(portion: NewPortion, others: OtherLabels, envelopes: EnvelopeClient): Promise<WriteResult> {
  const sealed = await sealPortion(portion.label, portion.text, others, envelopes);
  if (sealed.status === 'not-encrypted') {
    return sealed;
  }
  const id = crypto.randomUUID();
  const xml = buildPortionPart({ id, version: 1, labelCode: portion.label.code, labelXml: sealed.labelXml, envelope: sealed.envelope });
  return writeLabelling({ kind: 'insertion', alias: messages.portionAlias, block: portionBlockScope(id, portion.label), xml }, sealed.documentLabel, others);
}

// The new text is sealed before anything reaches the document: a text that
// cannot be encrypted changes nothing. Under a new label, the placeholder,
// the document label and the page marking change with it.
export async function changePortion(change: PortionChange, others: OtherLabels, envelopes: EnvelopeClient): Promise<WriteResult> {
  const { label, portion } = change;
  const sealed = await sealPortion(label, change.text, others, envelopes);
  if (sealed.status === 'not-encrypted') {
    return sealed;
  }
  const xml = buildPortionPart({ id: portion.id, version: nextVersion(portion), labelCode: label.code, labelXml: sealed.labelXml, envelope: sealed.envelope });
  return writeLabelling({ kind: 'change', id: portion.id, block: portionBlockScope(portion.id, label), xml }, sealed.documentLabel, others);
}

// Deletes a portion and its part, with the document label and the page
// marking that the document's other labels give.
export async function deletePortion(portion: StoredPortion, policy: string, others: OtherLabels): Promise<WriteResult> {
  const documentLabel = await fetchDocumentLabel({ policy, ...others });
  return writeLabelling({ kind: 'deletion', id: portion.id }, documentLabel, others);
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
async function sealPortion(label: LabelView, text: string, others: OtherLabels, envelopes: EnvelopeClient): Promise<SealedPortion> {
  const [labelXml, attributes, documentLabel] = await Promise.all([
    fetchAdatp4774(label.policy, label.code),
    fetchLabelAttributes(label.policy, label.code),
    fetchDocumentLabel({ policy: label.policy, baseLabelCode: others.baseLabelCode, portionLabelCodes: [...others.portionLabelCodes, label.code] }),
  ]);
  const sealed = await envelopes.seal(text, { xml: labelXml, attributes });
  return sealed.status === 'failed' ? { status: 'not-encrypted', reason: sealed.reason } : { status: 'sealed', labelXml, envelope: sealed.envelope, documentLabel };
}

function portionBlockScope(id: string, label: LabelView): PortionBlockScope {
  const tag: PortionTag = { v: 1, id, label: label.code };
  return { tag: JSON.stringify(tag), color: label.marking.color, placeholder: messages.portionPlaceholder(label.marking.text) };
}

async function writeLabelling(portion: PortionWriteScope, documentLabel: DocumentLabel, others: OtherLabels): Promise<WriteResult> {
  const written = await runCommand(
    writeLabellingCommand,
    { portion, portionNamespace: PORTION_NAMESPACE, ...documentLabelScope(documentLabel, others.baseLabelCode) },
    true,
    (result) => (typeof result === 'boolean' ? result : null),
  );
  return written === true ? { status: 'written' } : { status: 'not-written' };
}

// Rewrites the document label, and its page marking, from the base label and
// the portions' labels.
export async function writeDocumentLabel(request: DocumentLabelRequest): Promise<boolean> {
  const documentLabel = await fetchDocumentLabel(request);
  const done = await runCommand(
    writeLabellingCommand,
    { portion: null, ...documentLabelScope(documentLabel, request.baseLabelCode) },
    true,
    (result) => (result === true ? true : null),
  );
  return done === true;
}

// Portions in document order, each joined with the content of its part.
export async function readDocumentState(): Promise<DocumentState> {
  const snapshot = await runCommand(
    readDocumentCommand,
    { portionNamespace: PORTION_NAMESPACE, documentNamespace: DOCUMENT_NAMESPACE },
    false,
    parseSnapshot,
  );
  if (snapshot === null) {
    return { portions: [], baseLabelCode: null, documentLabelCode: null, pageMarking: null };
  }
  const contents = new Map<string, PortionPartContent>();
  for (const xml of snapshot.portionParts) {
    const content = parsePortionPart(xml);
    if (content !== null) {
      contents.set(content.id, content);
    }
  }
  const portions = snapshot.controls.flatMap((control) => {
    const tag = parsePortionTag(control.tag);
    if (tag === null) {
      return [];
    }
    const content = contents.get(tag.id) ?? null;
    return [
      {
        id: tag.id,
        labelCode: tag.label,
        partLabelCode: content?.labelCode ?? null,
        partLabelXml: content?.labelXml ?? null,
        version: content?.version ?? null,
        content: content?.content ?? null,
        internalId: control.internalId,
      },
    ];
  });
  const documentPart = snapshot.documentParts.map(parseDocumentPart).find((part) => part !== null) ?? null;
  return {
    portions,
    baseLabelCode: documentPart?.base ?? null,
    documentLabelCode: documentPart?.label ?? null,
    pageMarking: pageMarkingOf(snapshot.headersAndFooters),
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
    pageMarking: { tag: JSON.stringify(tag), alias: messages.pageMarkingAlias, text: label.marking.text, color: label.marking.color },
  };
}

// What every header and footer shows, each in one locked page marking in its
// place; null when one of them does not.
function pageMarkingOf(headersAndFooters: HeaderFooterSnapshot[]): ShownPageMarking | null {
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
    return { labelCode: marking.labelCode, text: marking.block.text };
  });
  const [first] = shown;
  return first !== undefined && first !== null && shown.every((one) => one?.labelCode === first.labelCode && one.text === first.text) ? first : null;
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
  const { controls, portionParts, documentParts, headersAndFooters } = result as Record<string, unknown>; // SAFETY: object checked above
  if (!Array.isArray(controls) || !Array.isArray(portionParts) || !Array.isArray(documentParts) || !Array.isArray(headersAndFooters)) {
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
    portionParts: portionParts.filter(isString),
    documentParts: documentParts.filter(isString),
    headersAndFooters: headersAndFooters.map(parseHeaderFooter),
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
