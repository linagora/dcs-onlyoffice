import { DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

export interface ContentControl {
  alias: string | null;
  tag: string | null;
  lock: string | null;
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
}

export interface DocxInspection {
  bodyText: string;
  // Text of every part, customXml included, to prove protected text stays out.
  allText: string;
  contentControls: ContentControl[];
  portionParts: PortionPart[];
  bindings: DocumentBinding[];
  // Present parts that ADatP-4778.2 Tables 5-2 and 5-3 require a whole-document
  // binding to reference.
  bindableParts: string[];
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';
const BINDABLE_PART = /^(word\/(document|styles|footnotes|endnotes|comments|commentsExtended)\.xml|word\/(header|footer)\d*\.xml|word\/media\/.+|docProps\/(core|app|custom)\.xml)$/;

export async function inspectDocx(docx: Buffer): Promise<DocxInspection> {
  const zip = await JSZip.loadAsync(docx);
  const documentXml = await readPart(zip, 'word/document.xml');
  const document = parse(documentXml);
  const allTexts: string[] = [];
  const portionParts: PortionPart[] = [];
  const bindings: DocumentBinding[] = [];
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
      }
    }
  }
  return {
    bodyText: textOf(document),
    allText: allTexts.join('\n'),
    contentControls: elements(document, WORD_NAMESPACE, 'sdt').map((sdt) => {
      const properties = elements(sdt, WORD_NAMESPACE, 'sdtPr')[0];
      return {
        alias: properties === undefined ? null : wordValue(properties, 'alias'),
        tag: properties === undefined ? null : wordValue(properties, 'tag'),
        lock: properties === undefined ? null : wordValue(properties, 'lock'),
        text: elements(sdt, WORD_NAMESPACE, 'sdtContent').map(textOf).join(''),
      };
    }),
    portionParts,
    bindings,
    bindableParts: Object.keys(zip.files)
      .filter((name) => zip.files[name]?.dir === false && BINDABLE_PART.test(name))
      .sort(),
  };
}

function readBinding(xml: string): DocumentBinding | null {
  const root = parse(xml);
  if (root.namespaceURI !== BINDING_NAMESPACE || root.localName !== 'BindingInformation') {
    return null;
  }
  const label = elements(root, LABEL_NAMESPACE, 'originatorConfidentialityLabel')[0];
  return {
    label: label === undefined ? null : readLabel(label),
    references: elements(root, BINDING_NAMESPACE, 'DataReference').map((reference) => reference.getAttribute('URI') ?? ''),
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

function parse(xml: string): Element {
  const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
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
  return elements(root, WORD_NAMESPACE, 'p')
    .map((paragraph) =>
      elements(paragraph, WORD_NAMESPACE, 't')
        .map((text) => text.textContent ?? '')
        .join(''),
    )
    .join('\n');
}
