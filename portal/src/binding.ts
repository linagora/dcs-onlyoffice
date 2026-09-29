import path from 'node:path';
import { type Document, DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CUSTOM_XML_ITEM = /^customXml\/item\d+\.xml$/;
// The relationship to a Custom XML Data Storage part, Transitional and Strict.
const CUSTOM_XML_RELATIONSHIPS: readonly string[] = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/customXml',
];
const RELATIONSHIPS_PART = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/;
const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';

// The signature of an earlier save covers the parts as they were: it is
// dropped before the policy service signs the binding again, with the parts
// the saved package holds, so that a binding it could not sign is stored
// unsigned.
export async function withoutSignature(file: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(file);
  let changed = false;
  for (const { name, document } of await customXmlParts(zip)) {
    const root = document.documentElement;
    if (root === null || root.namespaceURI !== BINDING_NAMESPACE || root.localName !== 'BindingInformation') {
      continue;
    }
    const signatures = Array.from(root.childNodes).filter((node) => node.namespaceURI === SIGNATURE_NAMESPACE && node.localName === 'Signature');
    for (const signature of signatures) {
      root.removeChild(signature);
    }
    if (signatures.length > 0) {
      zip.file(name, new XMLSerializer().serializeToString(document));
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) : file;
}

// The Custom XML parts of a package, parsed, whatever their names: the
// targets of the customXml relationships of its parts (ECMA-376 Part 1
// §15.2.5), and the parts named as Office and ONLYOFFICE name them, as the
// policy service finds them.
export async function customXmlParts(zip: JSZip): Promise<{ name: string; document: Document }[]> {
  const names = new Set(Object.keys(zip.files).filter((file) => zip.files[file]?.dir === false && CUSTOM_XML_ITEM.test(file)));
  for (const relationshipsPart of Object.keys(zip.files)) {
    const match = RELATIONSHIPS_PART.exec(relationshipsPart);
    const xml = match === null ? undefined : await zip.file(relationshipsPart)?.async('string');
    if (match === null || xml === undefined) {
      continue;
    }
    // Targets are relative to the part the relationships belong to.
    const base = match[1] ?? '';
    const relationships = new DOMParser().parseFromString(xml, 'text/xml');
    for (const relationship of Array.from(relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship'))) {
      const target = relationship.getAttribute('Target') ?? '';
      if (!CUSTOM_XML_RELATIONSHIPS.includes(relationship.getAttribute('Type') ?? '') || relationship.getAttribute('TargetMode') === 'External' || target === '') {
        continue;
      }
      const wanted = (target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base, target))).toLowerCase();
      const part = Object.keys(zip.files).find((file) => zip.files[file]?.dir === false && file.toLowerCase() === wanted);
      if (part !== undefined) {
        names.add(part);
      }
    }
  }
  const parts: { name: string; document: Document }[] = [];
  for (const name of [...names].sort()) {
    const xml = await zip.file(name)?.async('string');
    if (xml !== undefined) {
      parts.push({ name, document: new DOMParser().parseFromString(xml, 'text/xml') });
    }
  }
  return parts;
}
