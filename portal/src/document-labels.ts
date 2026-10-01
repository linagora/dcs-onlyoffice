import { readFile, stat } from 'node:fs/promises';
import { type Document, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { customXmlParts } from './binding.ts';
import type { StoredDocument } from './documents.ts';
import { parsePackageXml } from './xml.ts';

// The plugin keeps the base label the author chose in a Custom XML part of its
// own, and each portion's label in its portion's part (DOCUMENT_NAMESPACE and
// PORTION_NAMESPACE in plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';

// A portion's label in clear, in its part and in its placeholder's tag;
// null where the file holds none. A workbook's placeholder, a user protected
// range titled with the portion's id, holds no label: while it is there, its
// portion's part gives the label of both.
export interface PortionLabels {
  part: string | null;
  tag: string | null;
}

// The labels in clear a package holds: its base label, the document label
// the panel last wrote beside it, and each portion's labels by portion id.
export interface FileLabels {
  base: string | null;
  label: string | null;
  portions: Map<string, PortionLabels>;
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// The parts where the plugin's placeholders may be.
const PLACEHOLDER_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;
// The extension in which ONLYOFFICE writes a sheet's user protected ranges.
const USER_PROTECTED_RANGES_EXTENSION = '{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}';

export async function fileLabelsOf(file: Uint8Array): Promise<FileLabels> {
  const zip = await JSZip.loadAsync(file);
  return labelsIn(zip, await customXmlParts(zip));
}

// A portion of a stored file, as its portion page reads it: the label code its
// placeholder names, and its part, envelope included, null when the file
// holds none.
export interface StoredPortionPart {
  placeholderLabelCode: string;
  part: string | null;
}

// Null when the file holds no placeholder for the portion: as everywhere in
// the platform, a portion goes with its placeholder, whatever becomes of its
// part.
export async function storedPortionPartOf(file: Uint8Array, portionId: string): Promise<StoredPortionPart | null> {
  const zip = await JSZip.loadAsync(file);
  const parts = await customXmlParts(zip);
  const placeholderLabelCode = (await labelsIn(zip, parts)).portions.get(portionId)?.tag ?? null;
  if (placeholderLabelCode === null) {
    return null;
  }
  // Of several parts that name the portion, the last counts, as for its
  // label and in the panel.
  const part = parts.findLast(({ document }) => portionIdOf(document) === portionId);
  return { placeholderLabelCode, part: part === undefined ? null : new XMLSerializer().serializeToString(part.document) };
}

// The id of the portion whose part a document is, null for any other part.
function portionIdOf(document: Document): string | null {
  const root = document.documentElement;
  return root?.namespaceURI === PORTION_NAMESPACE && root.localName === 'portion' ? root.getAttribute('id') : null;
}

async function labelsIn(zip: JSZip, parts: { document: Document }[]): Promise<FileLabels> {
  const portions = new Map<string, PortionLabels>();
  const labelsOf = (id: string): PortionLabels => {
    const labels = portions.get(id) ?? { part: null, tag: null };
    portions.set(id, labels);
    return labels;
  };
  let base: string | null = null;
  let label: string | null = null;
  for (const { document } of parts) {
    const root = document.documentElement;
    if (root?.namespaceURI === DOCUMENT_NAMESPACE && root.localName === 'document') {
      base = root.getAttribute('base') || null;
      label = root.getAttribute('label') || null;
    }
    const id = portionIdOf(document);
    if (id !== null) {
      labelsOf(id).part = root?.getAttribute('label') ?? null;
    }
  }
  for (const part of await xmlPartsMatching(zip, PLACEHOLDER_PART)) {
    for (const tag of Array.from(part.getElementsByTagNameNS(WORD_NAMESPACE, 'tag'))) {
      const portion = portionTagOf(tag.getAttributeNS(WORD_NAMESPACE, 'val'));
      if (portion !== null) {
        labelsOf(portion.id).tag = portion.label;
      }
    }
  }
  for (const id of await userProtectedRangeTitles(zip)) {
    const labels = portions.get(id);
    if (labels !== undefined) {
      labels.tag = labels.part;
    }
  }
  return { base, label, portions };
}

// The documents of a package's XML parts whose names match.
async function xmlPartsMatching(zip: JSZip, name: RegExp): Promise<Document[]> {
  const parts: Document[] = [];
  for (const part of Object.keys(zip.files).filter((file) => name.test(file))) {
    const xml = await zip.file(part)?.async('string');
    if (xml !== undefined) {
      parts.push(parsePackageXml(xml));
    }
  }
  return parts;
}

// The titles of a workbook's user protected ranges, as ONLYOFFICE saves them
// in each worksheet.
async function userProtectedRangeTitles(zip: JSZip): Promise<Set<string>> {
  const titles = new Set<string>();
  for (const sheet of await xmlPartsMatching(zip, WORKSHEET_PART)) {
    const extensions = Array.from(sheet.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, 'ext'));
    for (const extension of extensions.filter((candidate) => candidate.getAttribute('uri') === USER_PROTECTED_RANGES_EXTENSION)) {
      for (const range of Array.from(extension.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, 'userProtectedRange'))) {
        titles.add(range.getAttribute('name') ?? '');
      }
    }
  }
  return titles;
}

// A placeholder's tag names its portion and its label.
function portionTagOf(tag: string | null): { id: string; label: string } | null {
  try {
    const parsed: unknown = JSON.parse(tag ?? 'null');
    return typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof parsed.id === 'string' &&
      'label' in parsed &&
      typeof parsed.label === 'string'
      ? { id: parsed.id, label: parsed.label }
      : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

// The labels a stored file names, its base label and its document label,
// read once for each version of the file. A file that cannot be read fails,
// so that its document stays closed.
export class StoredLabels {
  #known = new Map<string, { version: string } & Pick<FileLabels, 'base' | 'label'>>();

  // The base label, and the document label the panel last wrote beside it;
  // null for a label the file does not name.
  async of(document: StoredDocument): Promise<Pick<FileLabels, 'base' | 'label'>> {
    const { mtimeMs, size } = await stat(document.filePath);
    const version = `${mtimeMs}:${size}`;
    const known = this.#known.get(document.id);
    if (known?.version === version) {
      return known;
    }
    const { base, label } = await fileLabelsOf(await readFile(document.filePath));
    this.#known.set(document.id, { version, base, label });
    return { base, label };
  }

  // Forgets the documents that are no longer stored.
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.#known.keys()) {
      if (!ids.has(id)) {
        this.#known.delete(id);
      }
    }
  }
}
