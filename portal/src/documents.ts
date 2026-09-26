import { randomBytes } from 'node:crypto';
import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredDocument {
  id: string;
  fileName: string;
  filePath: string;
  key: string;
}

export interface DocumentTemplate {
  id: string;
  fileName: string;
}

export type SaveKind = 'session-ended' | 'forced';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface DocumentMetadata {
  epoch: string;
  version: number;
}

const DOCX_EXTENSION = '.docx';
const METADATA_EXTENSION = '.meta.json';
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function listDocuments(directory: string): Promise<StoredDocument[]> {
  const ids = await listDocxIds(directory);
  const documents = await Promise.all(ids.map((id) => findDocument(directory, id)));
  return documents.filter((document): document is StoredDocument => document !== null);
}

// A document seeded without metadata gets it on first lookup, so that its key
// stays stable from then on.
export async function findDocument(directory: string, id: string): Promise<StoredDocument | null> {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    return null;
  }
  const filePath = docxPath(directory, id);
  if (!(await fileExists(filePath))) {
    return null;
  }
  const metadata = await readOrCreateMetadata(directory, id);
  return { id, fileName: `${id}${DOCX_EXTENSION}`, filePath, key: documentKey(id, metadata) };
}

export async function listTemplates(directory: string): Promise<DocumentTemplate[]> {
  const ids = await listDocxIds(directory);
  return ids.map((id) => ({ id, fileName: `${id}${DOCX_EXTENSION}` }));
}

export async function createDocumentFromTemplate(
  documentsDirectory: string,
  templatesDirectory: string,
  templateId: string,
): Promise<StoredDocument | null> {
  if (!DOCUMENT_ID_PATTERN.test(templateId) || !(await fileExists(docxPath(templatesDirectory, templateId)))) {
    return null;
  }
  const id = `${templateId.slice(0, 80)}-${randomBytes(4).toString('hex')}`;
  await copyFile(docxPath(templatesDirectory, templateId), docxPath(documentsDirectory, id));
  return findDocument(documentsDirectory, id);
}

// A forced save keeps the editing session open, so the key must not change:
// co-authors joining later would otherwise land in a separate session. Only a
// save that ends the session moves the document to a new key.
export async function saveDocumentContent(
  directory: string,
  id: string,
  content: Uint8Array,
  kind: SaveKind,
): Promise<StoredDocument | null> {
  const current = await findDocument(directory, id);
  if (current === null) {
    return null;
  }
  const temporaryPath = `${current.filePath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, current.filePath);
  if (kind === 'session-ended') {
    const metadata = await readOrCreateMetadata(directory, id);
    await writeMetadata(directory, id, { ...metadata, version: metadata.version + 1 });
  }
  return findDocument(directory, id);
}

async function listDocxIds(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(DOCX_EXTENSION))
    .map((entry) => entry.name.slice(0, -DOCX_EXTENSION.length))
    .filter((id) => DOCUMENT_ID_PATTERN.test(id))
    .sort();
}

// The key may only use [0-9A-Za-z.=_-]. The random epoch keeps a deleted and
// recreated document from reusing a key the Document Server still caches.
function documentKey(id: string, metadata: DocumentMetadata): string {
  return `${id}-${metadata.epoch}-${metadata.version}`;
}

async function readOrCreateMetadata(directory: string, id: string): Promise<DocumentMetadata> {
  const existing = await readMetadata(directory, id);
  if (existing !== null) {
    return existing;
  }
  const created: DocumentMetadata = { epoch: randomBytes(4).toString('hex'), version: 1 };
  await writeMetadata(directory, id, created);
  return created;
}

async function readMetadata(directory: string, id: string): Promise<DocumentMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath(directory, id), 'utf8'));
    return isDocumentMetadata(parsed) ? parsed : null;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function writeMetadata(directory: string, id: string, metadata: DocumentMetadata): Promise<DocumentMetadata> {
  await writeFile(metadataPath(directory, id), JSON.stringify(metadata));
  return metadata;
}

function isDocumentMetadata(value: unknown): value is DocumentMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'version' in value &&
    typeof value.version === 'number'
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function docxPath(directory: string, id: string): string {
  return path.join(directory, `${id}${DOCX_EXTENSION}`);
}

function metadataPath(directory: string, id: string): string {
  return path.join(directory, `${id}${METADATA_EXTENSION}`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
