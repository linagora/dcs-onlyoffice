import { randomBytes } from 'node:crypto';
import { copyFile, link, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
  // The name of the file an upload brought, which the portal shows.
  name?: string;
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
  return { id, fileName: metadata.name ?? `${id}${DOCX_EXTENSION}`, filePath, key: documentKey(id, metadata) };
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
  const id = newDocumentId(templateId);
  await copyFile(docxPath(templatesDirectory, templateId), docxPath(documentsDirectory, id));
  return findDocument(documentsDirectory, id);
}

// A new document's identifier: the name it comes from, in the characters an
// identifier allows, with a random suffix.
export function newDocumentId(name: string): string {
  const stem = name
    .replace(/\.docx$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
  return `${stem === '' ? 'document' : stem}-${randomBytes(4).toString('hex')}`;
}

// Stores a new document under an identifier that names no stored document,
// with the name of the file it comes from: the file appears whole, and with
// its name, or not at all.
export async function storeNewDocument(directory: string, id: string, content: Uint8Array, name: string): Promise<StoredDocument> {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid document identifier ${id}`);
  }
  const shown = shownName(name);
  await writeMetadata(directory, id, { epoch: randomBytes(4).toString('hex'), version: 1, ...(shown === null ? {} : { name: shown }) });
  const filePath = docxPath(directory, id);
  const temporaryPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporaryPath, content);
  try {
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath);
  }
  const stored = await findDocument(directory, id);
  if (stored === null) {
    throw new Error(`Document ${id} vanished once stored`);
  }
  return stored;
}

// A file name as the portal shows it: its last segment, without control
// characters; null when nothing is left.
function shownName(name: string): string | null {
  const shown = (name.split(/[\\/]/).at(-1) ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, 200);
  return shown === '' ? null : shown;
}

// A forced save keeps the editing session open, so the key must not change:
// co-authors joining later would otherwise land in a separate session. Only a
// save that ends the session moves the document to a new key, besides the
// portal ending a session (moveDocumentToNewKey).
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
    await incrementVersion(directory, id);
  }
  return findDocument(directory, id);
}

// The document's next editing session gets a key that no earlier editor
// configuration names.
export async function moveDocumentToNewKey(directory: string, id: string): Promise<StoredDocument | null> {
  if ((await findDocument(directory, id)) === null) {
    return null;
  }
  await incrementVersion(directory, id);
  return findDocument(directory, id);
}

async function incrementVersion(directory: string, id: string): Promise<void> {
  const metadata = await readOrCreateMetadata(directory, id);
  await writeMetadata(directory, id, { ...metadata, version: metadata.version + 1 });
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
    typeof value.version === 'number' &&
    (!('name' in value) || typeof value.name === 'string')
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
