import { DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

export interface ContentControl {
  alias: string | null;
  tag: string | null;
  lock: string | null;
  text: string;
  links: ContentControlLink[];
}

// A link in a content control's content: the address its relationship
// targets, null for a place in the document, and the text it spans.
export interface ContentControlLink {
  target: string | null;
  text: string;
}

export interface PortionPart {
  id: string | null;
  version: string | null;
  label: string | null;
  labelXml: string;
  encoding: string | null;
  // The content element's text as stored: an envelope or, in unencrypted
  // portions, the text itself, both base64.
  content: string;
}

export interface LabelCategory {
  type: string | null;
  tagName: string | null;
  values: string[];
}

export interface ConfidentialityLabel {
  policy: string;
  classification: string;
  categories: LabelCategory[];
}

export interface DocumentBinding {
  label: ConfidentialityLabel | null;
  references: string[];
  // Whether an XML signature opens the binding.
  signed: boolean;
  // The certificate the signature's KeyInfo holds, in base64; null without
  // one.
  signingCertificate: string | null;
}

// A block content control with the colour of its text.
export interface HeaderFooterControl {
  control: ContentControl;
  color: string | null;
}

// A block of a header or a footer: a paragraph's text, or a block content
// control.
export type HeaderFooterBlock = { paragraph: string } | HeaderFooterControl;

export interface HeaderFooter {
  kind: 'header' | 'footer';
  // default, first or even, as the section refers to it.
  type: string | null;
  blocks: HeaderFooterBlock[];
}

// What a package, a text document's or a workbook's, holds of the platform's
// labels.
export interface PackageInspection {
  // Text of every part, customXml included, to prove protected text stays out.
  allText: string;
  portionParts: PortionPart[];
  bindings: DocumentBinding[];
  // The custom document properties, where the sensitivity label goes.
  customProperties: CustomProperty[];
  // The code of the base label, as the panel writes it; null without one.
  baseLabel: string | null;
  // The code of the document label the panel last wrote beside the base
  // label, which it rewrites when it finds it stale; null without one.
  documentLabel: string | null;
  // Present parts that a whole-document binding references: those of
  // ADatP-4778.2 Tables 5-2 and 5-3 and the others that can hold content, by
  // format; the Custom XML parts but the binding's; the relationship parts
  // and the content types.
  bindableParts: string[];
}

export interface DocxInspection extends PackageInspection {
  bodyText: string;
  contentControls: ContentControl[];
  // The headers and footers the document's sections refer to.
  headersAndFooters: HeaderFooter[];
}

// The targets of a part's relationships, by their ids.
export type RelationshipTargets = Map<string | null, string | null>;

export interface CustomProperty {
  fmtid: string | null;
  name: string;
  // The value's variant type, such as lpwstr.
  type: string | null;
  value: string;
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const CUSTOM_PROPERTIES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VARIANT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
export const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';
export const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';
// ADatP-4778.2 Tables 5-2 and 5-3 for WordprocessingML, and the parts that can
// hold a text document's content that the tables leave out, as
// docs/research/labelling-standards.md, section 4.9, lists them.
const BINDABLE_PART = new RegExp(
  '^(' +
    [
      String.raw`word/(document|styles|footnotes|endnotes|comments|commentsExtended)\.xml`,
      String.raw`word/(header|footer)\d*\.xml`,
      String.raw`word/media/.+`,
      String.raw`docProps/(core|app|custom)\.xml`,
      String.raw`word/(people|commentsIds|commentsExtensible)\.xml`,
      String.raw`word/glossary/(document|styles)\.xml`,
      String.raw`word/charts/(chart|chartEx|colors|styles?)\d+\.xml`,
      String.raw`word/drawings/[^/]+\.xml`,
      String.raw`word/diagrams/[^/]+\.xml`,
      String.raw`word/(embeddings|ink|activeX)/.+`,
      String.raw`docProps/thumbnail\.[^/]+`,
    ].join('|') +
    ')$',
);
// The parts a whole-document binding references in either format: the
// relationship parts, the content types, and the Custom XML parts and their
// properties parts.
const PACKAGE_PART = /^((.+\/)?_rels\/[^/]*\.rels|\[Content_Types\]\.xml|customXml\/[^/]+)$/;

export async function inspectDocx(docx: Buffer): Promise<DocxInspection> {
  const zip = await JSZip.loadAsync(docx);
  const document = parse(await readPart(zip, 'word/document.xml'));
  const targets = await relationshipTargets(zip, 'word/document.xml');
  return {
    ...(await inspectPackage(zip, BINDABLE_PART)),
    bodyText: textOf(document),
    contentControls: elements(document, WORD_NAMESPACE, 'sdt').map((sdt) => readContentControl(sdt, targets)),
    headersAndFooters: await readHeadersAndFooters(zip, document, targets),
  };
}

// `bindablePart` matches the parts that can hold content in the package's
// format.
export async function inspectPackage(zip: JSZip, bindablePart: RegExp): Promise<PackageInspection> {
  const allTexts: string[] = [];
  const portionParts: PortionPart[] = [];
  const bindings: DocumentBinding[] = [];
  const bindingParts: string[] = [];
  let baseLabel: string | null = null;
  let documentLabel: string | null = null;
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name];
    if (file === undefined || file.dir) {
      continue;
    }
    const content = await file.async('string');
    allTexts.push(content);
    if (/^customXml\/item\d+\.xml$/.test(name)) {
      const part = readPortionPart(content);
      if (part !== null) {
        portionParts.push(part);
      }
      const binding = readBinding(content);
      if (binding !== null) {
        bindings.push(binding);
        bindingParts.push(name);
      }
      const root = parse(content);
      if (root.namespaceURI === DOCUMENT_NAMESPACE && root.localName === 'document') {
        baseLabel = root.getAttribute('base');
        documentLabel = root.getAttribute('label');
      }
    }
  }
  return {
    allText: allTexts.join('\n'),
    portionParts,
    bindings,
    customProperties: await readCustomProperties(zip),
    baseLabel,
    documentLabel,
    bindableParts: Object.keys(zip.files)
      .filter((name) => zip.files[name]?.dir === false && (bindablePart.test(name) || PACKAGE_PART.test(name)) && !bindingParts.includes(name))
      .sort(),
  };
}

async function readCustomProperties(zip: JSZip): Promise<CustomProperty[]> {
  const xml = await zip.file('docProps/custom.xml')?.async('string');
  if (xml === undefined) {
    return [];
  }
  return elements(parse(xml), CUSTOM_PROPERTIES_NAMESPACE, 'property').map((property) => {
    const [value] = childElements(property).filter((child) => child.namespaceURI === VARIANT_TYPES_NAMESPACE);
    return { fmtid: property.getAttribute('fmtid'), name: property.getAttribute('name') ?? '', type: value?.localName ?? null, value: value?.textContent ?? '' };
  });
}

// The properties of the sensitivity label `labelId`, by attribute name
// (MSIP_Label_<label id>_<attribute>).
export function sensitivityLabelProperties(inspected: PackageInspection, labelId: string): Record<string, string> {
  const prefix = `MSIP_Label_${labelId}_`;
  return Object.fromEntries(
    inspected.customProperties.filter((property) => property.name.startsWith(prefix)).map((property) => [property.name.slice(prefix.length), property.value]),
  );
}

function readContentControl(sdt: Element, targets: RelationshipTargets): ContentControl {
  const properties = elements(sdt, WORD_NAMESPACE, 'sdtPr')[0];
  const content = elements(sdt, WORD_NAMESPACE, 'sdtContent');
  return {
    alias: properties === undefined ? null : wordValue(properties, 'alias'),
    tag: properties === undefined ? null : wordValue(properties, 'tag'),
    lock: properties === undefined ? null : wordValue(properties, 'lock'),
    text: content.map(textOf).join(''),
    links: content
      .flatMap((element) => elements(element, WORD_NAMESPACE, 'hyperlink'))
      .map((link) => ({ target: targets.get(link.getAttributeNS(RELATIONSHIP_NAMESPACE, 'id')) ?? null, text: paragraphText(link) })),
  };
}

// The targets of a part's relationships, by their ids; none when the part
// has no relationship part.
export async function relationshipTargets(zip: JSZip, part: string): Promise<RelationshipTargets> {
  const folder = part.lastIndexOf('/');
  const xml = await zip.file(`${part.slice(0, folder)}/_rels/${part.slice(folder + 1)}.rels`)?.async('string');
  if (xml === undefined) {
    return new Map();
  }
  const relationships = parse(xml);
  return new Map(
    elements(relationships, PACKAGE_RELATIONSHIP_NAMESPACE, 'Relationship').map((relationship) => [
      relationship.getAttribute('Id'),
      relationship.getAttribute('Target'),
    ]),
  );
}

async function readHeadersAndFooters(zip: JSZip, document: Element, targets: RelationshipTargets): Promise<HeaderFooter[]> {
  const found: HeaderFooter[] = [];
  for (const kind of ['header', 'footer'] as const) {
    for (const reference of elements(document, WORD_NAMESPACE, `${kind}Reference`)) {
      const target = targets.get(reference.getAttributeNS(RELATIONSHIP_NAMESPACE, 'id'));
      if (target === undefined || target === null) {
        throw new Error(`A ${kind} reference names no part`);
      }
      const part = parse(await readPart(zip, `word/${target}`));
      const partTargets = await relationshipTargets(zip, `word/${target}`);
      found.push({
        kind,
        type: reference.getAttributeNS(WORD_NAMESPACE, 'type'),
        blocks: childElements(part).flatMap((element) => readBlock(element, partTargets)),
      });
    }
  }
  return found;
}

function readBlock(element: Element, targets: RelationshipTargets): HeaderFooterBlock[] {
  if (element.namespaceURI !== WORD_NAMESPACE) {
    return [];
  }
  switch (element.localName) {
    case 'p':
      return [{ paragraph: paragraphText(element) }];
    case 'sdt': {
      const color = elements(element, WORD_NAMESPACE, 'sdtContent').flatMap((content) => elements(content, WORD_NAMESPACE, 'color'))[0];
      return [{ control: readContentControl(element, targets), color: color?.getAttributeNS(WORD_NAMESPACE, 'val')?.toUpperCase() ?? null }];
    }
    default:
      return [];
  }
}

function readBinding(xml: string): DocumentBinding | null {
  const root = parse(xml);
  if (root.namespaceURI !== BINDING_NAMESPACE || root.localName !== 'BindingInformation') {
    return null;
  }
  const label = elements(root, LABEL_NAMESPACE, 'originatorConfidentialityLabel')[0];
  const first = childElements(root)[0];
  return {
    label: label === undefined ? null : readLabel(label),
    references: elements(root, BINDING_NAMESPACE, 'DataReference').map((reference) => reference.getAttribute('URI') ?? ''),
    signed: first?.namespaceURI === SIGNATURE_NAMESPACE && first.localName === 'Signature',
    signingCertificate: elements(root, SIGNATURE_NAMESPACE, 'X509Certificate')[0]?.textContent?.replace(/\s/g, '') ?? null,
  };
}

function readLabel(label: Element): ConfidentialityLabel {
  const text = (localName: string): string => elements(label, LABEL_NAMESPACE, localName)[0]?.textContent ?? '';
  return {
    policy: text('PolicyIdentifier'),
    classification: text('Classification'),
    categories: elements(label, LABEL_NAMESPACE, 'Category').map((category) => ({
      type: category.getAttribute('Type'),
      tagName: category.getAttribute('TagName'),
      values: elements(category, LABEL_NAMESPACE, 'GenericValue').map((value) => value.textContent ?? ''),
    })),
  };
}

function readPortionPart(xml: string): PortionPart | null {
  const root = parse(xml);
  if (root.namespaceURI !== PORTION_NAMESPACE || root.localName !== 'portion') {
    return null;
  }
  const label = elements(root, PORTION_NAMESPACE, 'label')[0];
  const content = elements(root, PORTION_NAMESPACE, 'content')[0];
  const labelElement = label === undefined ? null : (childElements(label)[0] ?? null);
  return {
    id: root.getAttribute('id'),
    version: root.getAttribute('version'),
    label: root.getAttribute('label'),
    labelXml: labelElement === null ? '' : new XMLSerializer().serializeToString(labelElement),
    encoding: content === undefined ? null : content.getAttribute('encoding'),
    content: content === undefined ? '' : (content.textContent ?? '').trim(),
  };
}

// The text of each header's and footer's page marking: the plugin's content
// control, first in a header and last in a footer, and the only one; null for
// a part without it.
export function pageMarkingTexts(docx: DocxInspection): (string | null)[] {
  return docx.headersAndFooters.map((part) => {
    const [marking, ...others] = part.blocks.filter(isPageMarking);
    const placed = part.kind === 'header' ? part.blocks[0] : part.blocks.at(-1);
    return marking !== undefined && others.length === 0 && marking === placed ? marking.control.text : null;
  });
}

function isPageMarking(block: HeaderFooterBlock): block is HeaderFooterControl {
  if (!('control' in block)) {
    return false;
  }
  const tag = parsedTag(block.control.tag);
  return typeof tag === 'object' && tag !== null && 'kind' in tag && tag.kind === 'page-marking';
}

// A content control's tag, parsed when it is JSON, as the plugin's tags are.
// The id of the portion that a content control's tag names, null for any
// other content control.
export function portionIdOfTag(tag: string | null): string | null {
  const parsed = parsedTag(tag);
  return typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : null;
}

export function parsedTag(tag: string | null): unknown {
  if (tag === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(tag);
    return parsed;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return tag;
    }
    throw error;
  }
}

// The label an ADatP-4774 XML document holds, or null when it holds none.
export function labelOfXml(xml: string): ConfidentialityLabel | null {
  const root = parse(xml);
  const label = root.namespaceURI === LABEL_NAMESPACE && root.localName === 'originatorConfidentialityLabel' ? root : elements(root, LABEL_NAMESPACE, 'originatorConfidentialityLabel')[0];
  return label === undefined ? null : readLabel(label);
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const content = await zip.file(name)?.async('string');
  if (content === undefined) {
    throw new Error(`The DOCX has no ${name} part`);
  }
  return content;
}

// A byte order mark at the start of a part, which XML allows and Office
// writes in some parts, is left out.
function parse(xml: string): Element {
  const root = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'text/xml').documentElement;
  if (root === null) {
    throw new Error('Unparsable XML part');
  }
  return root;
}

function elements(parent: Element, namespace: string, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(namespace, localName));
}

function childElements(parent: Element): Element[] {
  const children: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      children.push(node as Element); // SAFETY: nodeType 1 is an element
    }
  }
  return children;
}

function wordValue(properties: Element, localName: string): string | null {
  return elements(properties, WORD_NAMESPACE, localName)[0]?.getAttributeNS(WORD_NAMESPACE, 'val') ?? null;
}

// Paragraph texts joined by newlines; runs of one paragraph are concatenated.
function textOf(root: Element): string {
  return elements(root, WORD_NAMESPACE, 'p').map(paragraphText).join('\n');
}

function paragraphText(paragraph: Element): string {
  return elements(paragraph, WORD_NAMESPACE, 't')
    .map((text) => text.textContent ?? '')
    .join('');
}
