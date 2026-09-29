import path from 'node:path';
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
// The relationship to a Custom XML Data Storage part, Transitional and Strict
// (ECMA-376 Part 1 §15.2.5).
const CUSTOM_XML_RELATIONSHIPS: readonly string[] = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/customXml',
];
const RELATIONSHIPS_PART = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/;

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

// The package part of that name, as the package spells it: part names match
// without regard to case (ECMA-376 Part 2 §6.2.2.3).
export function partNamed(zip: JSZip, name: string): string | null {
  const wanted = name.toLowerCase();
  return Object.keys(zip.files).find((file) => zip.files[file]?.dir === false && file.toLowerCase() === wanted) ?? null;
}

// A package's Custom XML Data Storage parts, whatever their names: the targets
// of the customXml relationships of its parts, and the parts named as Office
// and ONLYOFFICE name them.
export async function customXmlParts(zip: JSZip): Promise<string[]> {
  const parts = new Set(Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false && CUSTOM_XML_ITEM.test(name)));
  for (const relationshipsPart of Object.keys(zip.files)) {
    const match = RELATIONSHIPS_PART.exec(relationshipsPart);
    const relationships = match === null ? null : await xmlPartOf(zip, relationshipsPart);
    if (match === null || relationships === null) {
      continue;
    }
    // Targets are relative to the part the relationships belong to.
    const base = match[1] ?? '';
    for (const relationship of Array.from(relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship'))) {
      const target = relationship.getAttribute('Target') ?? '';
      if (!CUSTOM_XML_RELATIONSHIPS.includes(relationship.getAttribute('Type') ?? '') || relationship.getAttribute('TargetMode') === 'External' || target === '') {
        continue;
      }
      const part = partNamed(zip, target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base, target)));
      if (part !== null) {
        parts.add(part);
      }
    }
  }
  return [...parts].sort();
}

// Removes a parsed relationships part's relationships of a type.
export function removeRelationships(relationships: Document, type: string): void {
  for (const relationship of Array.from(relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship'))) {
    if (relationship.getAttribute('Type') === type) {
      relationship.parentNode?.removeChild(relationship);
    }
  }
}

// Removes a part's content type Override from the parsed content types part;
// part names match without regard to case (ECMA-376 Part 2 §6.2.2.3).
export function undeclareContentType(types: Document, partName: string): void {
  for (const override of Array.from(types.getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, 'Override'))) {
    if ((override.getAttribute('PartName') ?? '').toLowerCase() === partName.toLowerCase()) {
      override.parentNode?.removeChild(override);
    }
  }
}
