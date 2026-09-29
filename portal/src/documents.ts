import { randomBytes } from 'node:crypto';
import { copyFile, link, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The formats of documents: a text document, which ONLYOFFICE's text editor
// edits, and a workbook, which its spreadsheet editor edits.
export type DocumentFormat = 'docx' | 'xlsx';

export interface StoredDocument {
  id: string;
  format: DocumentFormat;
  fileName: string;
  filePath: string;
  key: string;
}

export interface DocumentTemplate {
  id: string;
  format: DocumentFormat;
  fileName: string;
}

export type SaveKind = 'session-ended' | 'forced';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Each format's file extension, media type and ONLYOFFICE editor.
export const DOCUMENT_FORMATS: Readonly<Record<DocumentFormat, { extension: string; contentType: string; documentType: 'word' | 'cell' }>> = {
  docx: { extension: '.docx', contentType: DOCX_CONTENT_TYPE, documentType: 'word' },
  xlsx: { extension: '.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', documentType: 'cell' },
};
// Every format, in the order in which a folder's files are looked for: should
// it hold both a DOCX and an XLSX for one identifier, the text document is the
// document.
const LOOKUP_ORDER: readonly DocumentFormat[] = ['docx', 'xlsx'];

// The formats' names, as the upload form and its messages give them.
export const FORMAT_NAMES = LOOKUP_ORDER.map((format) => DOCUMENT_FORMATS[format].extension.slice(1).toUpperCase()).join(' or ');

// A file name's format, which its extension gives, and the name without that
// extension; a null format, and the whole name, for another name.
export function splitFileName(name: string): { stem: string; format: DocumentFormat | null } {
  const lower = name.toLowerCase();
  const format = LOOKUP_ORDER.find((candidate) => lower.endsWith(DOCUMENT_FORMATS[candidate].extension)) ?? null;
  return { stem: format === null ? name : name.slice(0, -DOCUMENT_FORMATS[format].extension.length), format };
}

// A file name with the extension of a format, which replaces its own.
export function nameInFormat(name: string, format: DocumentFormat): string {
  return `${splitFileName(name).stem}${DOCUMENT_FORMATS[format].extension}`;
}

// The format a media type names; null for another type.
export function formatOfContentType(type: string | null): DocumentFormat | null {
  return LOOKUP_ORDER.find((format) => DOCUMENT_FORMATS[format].contentType === type?.split(';', 1)[0]?.trim()) ?? null;
}

interface DocumentMetadata {
  epoch: string;
  version: number;
  // The name of the file an upload brought, which the portal shows.
  name?: string;
}

const METADATA_EXTENSION = '.meta.json';
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

export async function listDocuments(directory: string): Promise<StoredDocument[]> {
  const ids = new Set((await listDocumentFiles(directory)).map((file) => file.id));
  const documents = await Promise.all([...ids].map((id) => findDocument(directory, id)));
  return documents.filter((document): document is StoredDocument => document !== null);
}

// A document seeded without metadata gets it on first lookup, so that its key
// stays stable from then on.
export async function findDocument(directory: string, id: string): Promise<StoredDocument | null> {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    return null;
  }
  const format = await formatOf(directory, id);
  if (format === null) {
    return null;
  }
  const metadata = await readOrCreateMetadata(directory, id);
  const filePath = documentPath(directory, id, format);
  return { id, format, fileName: metadata.name ?? fileNameOf(id, format), filePath, key: documentKey(id, metadata) };
}

export async function listTemplates(directory: string): Promise<DocumentTemplate[]> {
  return (await listDocumentFiles(directory)).map(({ id, format }) => ({ id, format, fileName: fileNameOf(id, format) }));
}

export async function createDocumentFromTemplate(
  documentsDirectory: string,
  templatesDirectory: string,
  templateId: string,
): Promise<StoredDocument | null> {
  const format = DOCUMENT_ID_PATTERN.test(templateId) ? await formatOf(templatesDirectory, templateId) : null;
  if (format === null) {
    return null;
  }
  const id = newDocumentId(templateId);
  await copyFile(documentPath(templatesDirectory, templateId, format), documentPath(documentsDirectory, id, format));
  return findDocument(documentsDirectory, id);
}

// A new document's identifier: the name it comes from, without a format's
// extension, in the characters an identifier allows, with a random suffix.
export function newDocumentId(name: string): string {
  const stem = splitFileName(name)
    .stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
  return `${stem === '' ? 'document' : stem}-${randomBytes(4).toString('hex')}`;
}

// Stores a new document of a format under an identifier that names no stored
// document, with the name of the file it comes from: the file appears whole,
// and with its name, or not at all.
export async function storeNewDocument(directory: string, id: string, content: Uint8Array, format: DocumentFormat, name: string): Promise<StoredDocument> {
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid document identifier ${id}`);
  }
  const shown = shownName(name);
  await writeMetadata(directory, id, { epoch: randomBytes(4).toString('hex'), version: 1, ...(shown === null ? {} : { name: shown }) });
  const filePath = documentPath(directory, id, format);
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

// The documents a folder holds, by identifier, in identifier order.
async function listDocumentFiles(directory: string): Promise<{ id: string; format: DocumentFormat }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const { stem: id, format } = splitFileName(entry.name);
      return entry.isFile() && format !== null && DOCUMENT_ID_PATTERN.test(id) ? [{ id, format }] : [];
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// The format of the file a folder holds for an identifier, the text
// document's first; null when it holds none.
async function formatOf(directory: string, id: string): Promise<DocumentFormat | null> {
  for (const format of LOOKUP_ORDER) {
    if (await fileExists(documentPath(directory, id, format))) {
      return format;
    }
  }
  return null;
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

function documentPath(directory: string, id: string, format: DocumentFormat): string {
  return path.join(directory, fileNameOf(id, format));
}

// The name of a document's file, and of its download when it keeps no other.
export function fileNameOf(id: string, format: DocumentFormat): string {
  return `${id}${DOCUMENT_FORMATS[format].extension}`;
}

function metadataPath(directory: string, id: string): string {
  return path.join(directory, `${id}${METADATA_EXTENSION}`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
