import { readFile, stat } from 'node:fs/promises';
import JSZip from 'jszip';
import { customXmlParts } from './binding.ts';
import type { StoredDocument } from './documents.ts';

// The plugin keeps the base label the author chose in a Custom XML part of its
// own (DOCUMENT_NAMESPACE in plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';

// The code of a DOCX package's base label, null when it has none yet.
export async function baseLabelCodeOf(docx: Uint8Array): Promise<string | null> {
  for (const { document } of await customXmlParts(await JSZip.loadAsync(docx))) {
    const root = document.documentElement;
    if (root !== null && root.namespaceURI === DOCUMENT_NAMESPACE && root.localName === 'document') {
      const base = root.getAttribute('base');
      return base === null || base === '' ? null : base;
    }
  }
  return null;
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
    const code = await baseLabelCodeOf(await readFile(document.filePath));
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
