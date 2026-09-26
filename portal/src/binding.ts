import { type Document, DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const XMIME_NAMESPACE = 'http://www.w3.org/2005/05/xmlmime';
const DOCUMENT_BINDING_ID = 'mb-document';

// ADatP-4778.2 Tables 5-2 and 5-3 (WordprocessingML), in reference order.
const BINDABLE_PARTS: readonly RegExp[] = [
  /^word\/document\.xml$/,
  /^word\/styles\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/comments\.xml$/,
  /^word\/commentsExtended\.xml$/,
  /^word\/media\/.+$/,
  /^docProps\/core\.xml$/,
  /^docProps\/app\.xml$/,
  /^docProps\/custom\.xml$/,
];

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

// A whole-document binding must reference every present part of Tables 5-2
// and 5-3. Only the saved package tells which parts exist, so the reference
// list of the document label is rewritten at every save.
export async function refreshBindingReferences(docx: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  const files = Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false);
  const wanted = BINDABLE_PARTS.flatMap((pattern) => files.filter((name) => pattern.test(name)).sort());
  let changed = false;
  for (const name of files.filter((file) => /^customXml\/item\d+\.xml$/.test(file))) {
    const xml = await zip.file(name)?.async('string');
    if (xml === undefined) {
      continue;
    }
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const root = document.documentElement;
    if (root === null || root.namespaceURI !== BINDING_NAMESPACE || root.localName !== 'BindingInformation') {
      continue;
    }
    for (const binding of Array.from(root.getElementsByTagNameNS(BINDING_NAMESPACE, 'MetadataBinding'))) {
      if (binding.getAttribute('Id') === DOCUMENT_BINDING_ID && replaceReferences(document, binding, wanted)) {
        zip.file(name, new XMLSerializer().serializeToString(document));
        changed = true;
      }
    }
  }
  return changed ? zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) : docx;
}

function replaceReferences(document: Document, binding: Element, parts: string[]): boolean {
  const existing = Array.from(binding.getElementsByTagNameNS(BINDING_NAMESPACE, 'DataReference'));
  const current = existing.map((reference) => reference.getAttribute('URI'));
  const target = parts.map((part) => `pack:///${part}`);
  if (current.length === target.length && current.every((uri, index) => uri === target[index])) {
    return false;
  }
  for (const reference of existing) {
    binding.removeChild(reference);
  }
  const prefix = binding.prefix === null ? '' : `${binding.prefix}:`;
  for (const part of parts) {
    const reference = document.createElementNS(BINDING_NAMESPACE, `${prefix}DataReference`);
    reference.setAttribute('URI', `pack:///${part}`);
    const mediaType = MEDIA_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()];
    if (mediaType !== undefined) {
      reference.setAttributeNS(XMIME_NAMESPACE, 'xmime:contentType', mediaType);
    }
    binding.appendChild(reference);
  }
  return true;
}
