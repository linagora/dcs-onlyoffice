import { DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

export interface ContentControl {
  tag: string | null;
  lock: string | null;
  text: string;
}

export interface PortionPart {
  id: string | null;
  version: string | null;
  label: string | null;
  labelXml: string;
  content: string;
}

export interface DocxInspection {
  bodyText: string;
  // Text of every part except customXml, to prove protected text stays out.
  packageText: string;
  contentControls: ContentControl[];
  portionParts: PortionPart[];
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';

export async function inspectDocx(docx: Buffer): Promise<DocxInspection> {
  const zip = await JSZip.loadAsync(docx);
  const documentXml = await readPart(zip, 'word/document.xml');
  const document = parse(documentXml);
  const packageTexts: string[] = [];
  const portionParts: PortionPart[] = [];
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name];
    if (file === undefined || file.dir) {
      continue;
    }
    const content = await file.async('string');
    if (!name.startsWith('customXml/')) {
      packageTexts.push(content);
    } else if (/^customXml\/item\d+\.xml$/.test(name)) {
      const part = readPortionPart(content);
      if (part !== null) {
        portionParts.push(part);
      }
    }
  }
  return {
    bodyText: textOf(document),
    packageText: packageTexts.join('\n'),
    contentControls: elements(document, WORD_NAMESPACE, 'sdt').map((sdt) => {
      const properties = elements(sdt, WORD_NAMESPACE, 'sdtPr')[0];
      return {
        tag: properties === undefined ? null : wordValue(properties, 'tag'),
        lock: properties === undefined ? null : wordValue(properties, 'lock'),
        text: elements(sdt, WORD_NAMESPACE, 'sdtContent').map(textOf).join(''),
      };
    }),
    portionParts,
  };
}

function readPortionPart(xml: string): PortionPart | null {
  const root = parse(xml);
  if (root.namespaceURI !== PORTION_NAMESPACE || root.localName !== 'portion') {
    return null;
  }
  const label = elements(root, PORTION_NAMESPACE, 'label')[0];
  const content = elements(root, PORTION_NAMESPACE, 'content')[0];
  const labelElement = label === undefined ? undefined : childElements(label)[0];
  return {
    id: root.getAttribute('id'),
    version: root.getAttribute('version'),
    label: root.getAttribute('label'),
    labelXml: labelElement === undefined ? '' : new XMLSerializer().serializeToString(labelElement),
    content: content === undefined ? '' : Buffer.from((content.textContent ?? '').trim(), 'base64').toString('utf8'),
  };
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
