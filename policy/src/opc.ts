import type { Document } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { parseXml } from './xml.ts';

// The plumbing of Open Packaging Conventions packages (ECMA-376 Part 2).
export const PACKAGE_RELATIONSHIPS_PART = '_rels/.rels';
export const CONTENT_TYPES_PART = '[Content_Types].xml';
export const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
// The Custom XML Data Storage parts of an Office document, as Office and
// ONLYOFFICE name them.
export const CUSTOM_XML_ITEM: RegExp = /^customXml\/item\d+\.xml$/;

// The package a body holds, null when it is no ZIP package.
export async function loadPackage(body: Buffer): Promise<JSZip | null> {
  try {
    return await JSZip.loadAsync(body);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

// An XML part of a package, parsed; null when the package lacks it or when
// it is no well-formed XML without a DTD.
export async function xmlPartOf(zip: JSZip, part: string): Promise<Document | null> {
  const xml = await zip.file(part)?.async('string');
  const parsed = xml === undefined ? null : parseXml(xml);
  return parsed?.ok === true ? parsed.root.ownerDocument : null;
}

// Appends a relationship to a parsed relationships part, under an id that the
// part does not use yet.
export function appendRelationship(relationships: Document, type: string, target: string): void {
  const root = relationships.documentElement;
  if (root === null) {
    throw new Error('A relationships part without a root element');
  }
  const ids = new Set(Array.from(relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship')).map((relationship) => relationship.getAttribute('Id')));
  let number = ids.size + 1;
  while (ids.has(`rId${number}`)) {
    number += 1;
  }
  const relationship = relationships.createElementNS(RELATIONSHIPS_NAMESPACE, 'Relationship');
  relationship.setAttribute('Id', `rId${number}`);
  relationship.setAttribute('Type', type);
  relationship.setAttribute('Target', target);
  root.appendChild(relationship);
}

// Declares a part's content type in the parsed content types part, unless it
// already does; whether it did.
export function declareContentType(types: Document, partName: string, contentType: string): boolean {
  const root = types.documentElement;
  if (root === null) {
    throw new Error('A content types part without a root element');
  }
  const declared = Array.from(types.getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, 'Override')).some((override) => override.getAttribute('PartName') === partName);
  if (declared) {
    return false;
  }
  const override = types.createElementNS(CONTENT_TYPES_NAMESPACE, 'Override');
  override.setAttribute('PartName', partName);
  override.setAttribute('ContentType', contentType);
  root.appendChild(override);
  return true;
}
