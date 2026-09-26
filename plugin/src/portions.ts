import type { OfficeApi } from './office-api.ts';
import { runCommand } from './onlyoffice.ts';
import { fetchAdatp4774, type LabelView } from './policy.ts';

export const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';

export interface PortionTag {
  v: 1;
  id: string;
  label: string;
}

export interface StoredPortion {
  id: string;
  labelCode: string;
  version: number | null;
  text: string | null;
  internalId: string;
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
  namespace: string;
}

interface DocumentSnapshot {
  controls: { tag: string; internalId: string }[];
  parts: string[];
}

interface PortionPartContent {
  id: string;
  version: number;
  labelCode: string;
  text: string | null;
}

declare const Api: OfficeApi;
declare const Asc: { scope: CommandScope };

// One command inserts the placeholder block and its Custom XML part, so that a
// single undo removes both. The block is locked only once its text is set.
function insertPortionCommand(): string {
  const portion = Asc.scope.portion;
  const document = Api.GetDocument();
  const block = Api.CreateBlockLvlSdt();
  block.SetTag(portion.tag);
  block.SetAlias(portion.alias);
  if (portion.color !== null) {
    block.SetBorderColor(Api.HexColor(portion.color));
  }
  block.GetContent().GetElement(0)?.AddText(portion.placeholder);
  block.SetLock('sdtContentLocked');
  document.InsertContent([block]);
  document.GetCustomXmlParts().Add(portion.xml);
  return block.GetInternalId();
}

function readPortionsCommand(): DocumentSnapshot {
  const document = Api.GetDocument();
  const controls = document.GetAllContentControls().map((control) => ({
    tag: control.GetTag(),
    internalId: control.GetInternalId(),
  }));
  const parts = document
    .GetCustomXmlParts()
    .GetByNamespace(Asc.scope.namespace)
    .map((part) => part.GetXml());
  return { controls, parts };
}

export async function insertPortion(label: LabelView, text: string): Promise<boolean> {
  const labelXml = await fetchAdatp4774(label.policy, label.code);
  const id = crypto.randomUUID();
  const tag: PortionTag = { v: 1, id, label: label.code };
  const internalId = await runCommand(
    insertPortionCommand,
    {
      portion: {
        tag: JSON.stringify(tag),
        alias: 'Protected portion',
        color: label.marking.color,
        placeholder: `${label.marking.text} – protected portion`,
        xml: buildPortionPart({ id, version: 1, labelCode: label.code, labelXml, text }),
      },
    },
    true,
    (result) => (typeof result === 'string' ? result : null),
  );
  return internalId !== null;
}

// Portions in document order, each joined with the content of its part.
export async function readPortions(): Promise<StoredPortion[]> {
  const snapshot = await runCommand(readPortionsCommand, { namespace: PORTION_NAMESPACE }, false, parseSnapshot);
  if (snapshot === null) {
    return [];
  }
  const contents = new Map<string, PortionPartContent>();
  for (const xml of snapshot.parts) {
    const content = parsePortionPart(xml);
    if (content !== null) {
      contents.set(content.id, content);
    }
  }
  return snapshot.controls.flatMap((control) => {
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
        text: content?.text ?? null,
        internalId: control.internalId,
      },
    ];
  });
}

// The portion text is stored base64-encoded: the editor's XML serialiser does
// not escape `&`, `<` or quotes in text reliably.
export function buildPortionPart(portion: {
  id: string;
  version: number;
  labelCode: string;
  labelXml: string;
  text: string;
}): string {
  return (
    `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${portion.id}" version="${portion.version}" label="${escapeAttribute(portion.labelCode)}">` +
    `<dcs:label>${portion.labelXml}</dcs:label>` +
    `<dcs:content encoding="base64">${encodeBase64(portion.text)}</dcs:content>` +
    '</dcs:portion>'
  );
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
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (root.namespaceURI !== PORTION_NAMESPACE || root.localName !== 'portion') {
    return null;
  }
  const id = root.getAttribute('id');
  const labelCode = root.getAttribute('label');
  const version = Number(root.getAttribute('version'));
  if (id === null || labelCode === null || !Number.isInteger(version)) {
    return null;
  }
  const content = root.getElementsByTagNameNS(PORTION_NAMESPACE, 'content')[0];
  return { id, version, labelCode, text: content === undefined ? null : decodeBase64((content.textContent ?? '').trim()) };
}

function parseSnapshot(result: unknown): DocumentSnapshot | null {
  if (typeof result !== 'object' || result === null || !('controls' in result) || !('parts' in result)) {
    return null;
  }
  const { controls, parts } = result;
  if (!Array.isArray(controls) || !Array.isArray(parts)) {
    return null;
  }
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
    parts: parts.filter((part): part is string => typeof part === 'string'),
  };
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
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
