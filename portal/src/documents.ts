import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface StoredDocument {
  id: string;
  fileName: string;
  filePath: string;
  key: string;
}

const DOCX_EXTENSION = '.docx';
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function listDocuments(directory: string): Promise<StoredDocument[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(DOCX_EXTENSION))
    .map((entry) => entry.name.slice(0, -DOCX_EXTENSION.length))
    .filter((id) => DOCUMENT_ID_PATTERN.test(id))
    .sort();
  const documents = await Promise.all(ids.map((id) => findDocument(directory, id)));
  return documents.filter((document): document is StoredDocument => document !== null);
}

export async function findDocument(directory: string, id: string): Promise<StoredDocument | null> {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    return null;
  }
  const fileName = `${id}${DOCX_EXTENSION}`;
  const filePath = path.join(directory, fileName);
  try {
    const info = await stat(filePath);
    return { id, fileName, filePath, key: computeDocumentKey(id, info.mtimeMs, info.size) };
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

// ONLYOFFICE caches an opened document by its key: the key must change whenever
// the stored file changes, and may only use [0-9A-Za-z.=_-] (128 characters max).
function computeDocumentKey(id: string, modifiedAtMs: number, size: number): string {
  return createHash('sha256').update(`${id}:${modifiedAtMs}:${size}`).digest('base64url').slice(0, 32);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
