import type { EnvelopeClient } from './envelopes.ts';
import { messages } from './messages.ts';
import type { OfficeApi } from './office-api.ts';
import { runCommand } from './onlyoffice.ts';
import { type DocumentLabelRequest, fetchAdatp4774, fetchDocumentLabel, type LabelView } from './policy.ts';

export const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
export const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';

export interface PortionTag {
  v: 1;
  id: string;
  label: string;
}

// What a portion's part holds: an envelope, base64 as stored, or the text of
// an unencrypted portion, written before encryption existed.
export type PortionContent = { encoding: 'ztdf'; envelope: string } | { encoding: 'base64'; text: string | null };

export interface StoredPortion {
  id: string;
  labelCode: string;
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
}

export interface NewPortion {
  label: LabelView;
  text: string;
  baseLabelCode: string;
  existingLabelCodes: string[];
}

interface PartReplacement {
  namespace: string;
  xml: string;
}

interface InsertPortionScope {
  tag: string;
  alias: string;
  color: string | null;
  placeholder: string;
  xml: string;
}

interface CommandScope {
  portion: InsertPortionScope;
  replacements: PartReplacement[];
  portionNamespace: string;
  documentNamespace: string;
}

interface DocumentSnapshot {
  controls: { tag: string; internalId: string }[];
  portionParts: string[];
  documentParts: string[];
}

interface PortionPartContent {
  id: string;
  version: number;
  labelCode: string;
  content: PortionContent | null;
}

export type InsertionResult = { status: 'inserted' } | { status: 'not-encrypted'; reason: string } | { status: 'not-inserted' };

declare const Api: OfficeApi;
declare const Asc: { scope: CommandScope };

// One command inserts the placeholder block, the portion's Custom XML part and
// the updated document label, so that a single undo reverts all of them. The
// block is locked only once its text is set.
function insertPortionCommand(): string {
  const scope = Asc.scope;
  const document = Api.GetDocument();
  const block = Api.CreateBlockLvlSdt();
  block.SetTag(scope.portion.tag);
  block.SetAlias(scope.portion.alias);
  if (scope.portion.color !== null) {
    block.SetBorderColor(Api.HexColor(scope.portion.color));
  }
  block.GetContent().GetElement(0)?.AddText(scope.portion.placeholder);
  block.SetLock('sdtContentLocked');
  // Inserting at the cursor would split the paragraph that holds it. When
  // that paragraph has text and sits in the document body, the block goes
  // right after it; elsewhere (an empty paragraph, a table, a header) it goes
  // at the cursor, as the editor does.
  const paragraph = document.GetCurrentParagraph();
  const position = paragraph === null ? -1 : paragraph.GetPosInParent();
  const inBody = paragraph !== null && document.GetElement(position)?.GetInternalId?.() === paragraph.GetInternalId();
  if (inBody && paragraph.GetText().trim() !== '') {
    document.AddElement(position + 1, block);
  } else {
    document.InsertContent([block]);
  }
  const parts = document.GetCustomXmlParts();
  parts.Add(scope.portion.xml);
  for (const replacement of scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  return block.GetInternalId();
}

function replacePartsCommand(): boolean {
  const parts = Api.GetDocument().GetCustomXmlParts();
  for (const replacement of Asc.scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  return true;
}

function readDocumentCommand(): DocumentSnapshot {
  const document = Api.GetDocument();
  const parts = document.GetCustomXmlParts();
  return {
    controls: document.GetAllContentControls().map((control) => ({
      tag: control.GetTag(),
      internalId: control.GetInternalId(),
    })),
    portionParts: parts.GetByNamespace(Asc.scope.portionNamespace).map((part) => part.GetXml()),
    documentParts: parts.GetByNamespace(Asc.scope.documentNamespace).map((part) => part.GetXml()),
  };
}

// The text is sealed before anything reaches the document: a text that cannot
// be encrypted is not inserted.
export async function insertPortion(portion: NewPortion, envelopes: EnvelopeClient): Promise<InsertionResult> {
  const { label } = portion;
  const [labelXml, documentLabel] = await Promise.all([
    fetchAdatp4774(label.policy, label.code),
    fetchDocumentLabel({
      policy: label.policy,
      baseLabelCode: portion.baseLabelCode,
      portionLabelCodes: [...portion.existingLabelCodes, label.code],
    }),
  ]);
  const sealed = await envelopes.seal(portion.text, labelXml);
  if (sealed.status === 'failed') {
    return { status: 'not-encrypted', reason: sealed.reason };
  }
  const id = crypto.randomUUID();
  const tag: PortionTag = { v: 1, id, label: label.code };
  const internalId = await runCommand(
    insertPortionCommand,
    {
      portion: {
        tag: JSON.stringify(tag),
        alias: messages.portionAlias,
        color: label.marking.color,
        placeholder: messages.portionPlaceholder(label.marking.text),
        xml: buildPortionPart({ id, version: 1, labelCode: label.code, labelXml, envelope: sealed.envelope }),
      },
      replacements: documentLabelReplacements(documentLabel.xml, portion.baseLabelCode, documentLabel.label.code),
    },
    true,
    (result) => (typeof result === 'string' ? result : null),
  );
  return internalId === null ? { status: 'not-inserted' } : { status: 'inserted' };
}

// Rewrites the document label from the base label and the portions' labels.
export async function writeDocumentLabel(request: DocumentLabelRequest): Promise<boolean> {
  const documentLabel = await fetchDocumentLabel(request);
  const done = await runCommand(
    replacePartsCommand,
    { replacements: documentLabelReplacements(documentLabel.xml, request.baseLabelCode, documentLabel.label.code) },
    false,
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
    return { portions: [], baseLabelCode: null, documentLabelCode: null };
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
  };
}

// The standard ADatP-4778.2 part holds the document label; the project's own
// part keeps the base label the author chose.
function documentLabelReplacements(bindingXml: string, baseLabelCode: string, documentLabelCode: string): PartReplacement[] {
  return [
    { namespace: BINDING_NAMESPACE, xml: bindingXml },
    { namespace: DOCUMENT_NAMESPACE, xml: buildDocumentPart(baseLabelCode, documentLabelCode) },
  ];
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
  try {
    const parsed: unknown = JSON.parse(tag);
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
  return { id, version, labelCode, content: content === undefined ? null : contentOf(content) };
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
  const { controls, portionParts, documentParts } = result as Record<string, unknown>; // SAFETY: object checked above
  if (!Array.isArray(controls) || !Array.isArray(portionParts) || !Array.isArray(documentParts)) {
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
  };
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
