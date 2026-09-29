import { readFile, stat } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { customXmlParts } from './binding.ts';
import type { StoredDocument } from './documents.ts';

// The plugin keeps the base label the author chose in a Custom XML part of its
// own, and each portion's label in its portion's part (DOCUMENT_NAMESPACE and
// PORTION_NAMESPACE in plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';

// A portion's label in clear, in its part and in its placeholder's tag;
// null where the file holds none.
export interface PortionLabels {
  part: string | null;
  tag: string | null;
}

// The labels in clear a package holds: its base label, and each portion's
// labels by portion id.
export interface FileLabels {
  base: string | null;
  portions: Map<string, PortionLabels>;
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// The parts where the plugin's placeholders may be.
const PLACEHOLDER_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;

export async function fileLabelsOf(file: Uint8Array): Promise<FileLabels> {
  const zip = await JSZip.loadAsync(file);
  const portions = new Map<string, PortionLabels>();
  const labelsOf = (id: string): PortionLabels => {
    const labels = portions.get(id) ?? { part: null, tag: null };
    portions.set(id, labels);
    return labels;
  };
  let base: string | null = null;
  for (const { document } of await customXmlParts(zip)) {
    const root = document.documentElement;
    if (root?.namespaceURI === DOCUMENT_NAMESPACE && root.localName === 'document') {
      base = root.getAttribute('base') || null;
    }
    const id = root?.getAttribute('id') ?? null;
    if (root?.namespaceURI === PORTION_NAMESPACE && root.localName === 'portion' && id !== null) {
      labelsOf(id).part = root.getAttribute('label');
    }
  }
  for (const name of Object.keys(zip.files).filter((file) => PLACEHOLDER_PART.test(file))) {
    const xml = await zip.file(name)?.async('string');
    const tags = xml === undefined ? [] : Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(WORD_NAMESPACE, 'tag'));
    for (const tag of tags) {
      const portion = portionTagOf(tag.getAttributeNS(WORD_NAMESPACE, 'val'));
      if (portion !== null) {
        labelsOf(portion.id).tag = portion.label;
      }
    }
  }
  return { base, portions };
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

// Reads the base label of each stored document once per version of its file.
// A file that cannot be read fails, so that its document stays closed.
export class BaseLabels {
  #known = new Map<string, { version: string; code: string | null }>();

  async of(document: StoredDocument): Promise<string | null> {
    const { mtimeMs, size } = await stat(document.filePath);
    const version = `${mtimeMs}:${size}`;
    const known = this.#known.get(document.id);
    if (known?.version === version) {
      return known.code;
    }
    const code = (await fileLabelsOf(await readFile(document.filePath))).base;
    this.#known.set(document.id, { version, code });
    return code;
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
