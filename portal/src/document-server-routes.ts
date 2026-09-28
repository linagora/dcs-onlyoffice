import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { BindingSignatures } from './binding-signature.ts';
import { refreshBinding } from './binding.ts';
import type { PortalConfig } from './config.ts';
import { type FileLabels, fileLabelsOf } from './document-labels.ts';
import { DOCX_CONTENT_TYPE, findDocument, moveDocumentToNewKey, type SaveKind, saveDocumentContent, type StoredDocument } from './documents.ts';
import type { EditingSessions } from './editing-sessions.ts';
import { INTERNAL_DOCUMENTS_PATH, internalDocumentUrl } from './editor-config.ts';
import type { LabelJournal } from './label-journal.ts';
import {
  CALLBACK_FAILED,
  CALLBACK_RECEIVED,
  CALLBACK_STATUS,
  type CallbackPayload,
  readVerifiedCallback,
  readVerifiedDownloadUrl,
  toInternalUrl,
} from './onlyoffice.ts';

interface DocumentParams {
  id: string;
}

// What a save needs besides the file: the policy service's signature of its
// binding, the journal that logs the labels it lowers, and the editing
// sessions that follow it.
export interface SaveServices {
  signatures: BindingSignatures;
  journal: LabelJournal;
  editingSessions: EditingSessions;
}

// Routes the Document Server calls to load and save documents.
export function registerDocumentServerRoutes(app: FastifyInstance, config: PortalConfig, services: SaveServices): FastifyInstance {
  // Routes under /internal are only reachable from the Compose network: the
  // reverse proxy refuses them.
  // Only a Document Server download token for this very document's URL.
  app.get<{ Params: DocumentParams }>(`${INTERNAL_DOCUMENTS_PATH}/:id/content`, async (request, reply) => {
    const url = await readVerifiedDownloadUrl(request.headers.authorization, config.onlyofficeJwtSecret);
    if (url !== internalDocumentUrl(config, request.params.id, 'content')) {
      request.log.warn({ documentId: request.params.id }, 'Rejected a document download without a Document Server token for it');
      return reply.code(401).send({ error: 'No Document Server token for this document' });
    }
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const content = await readFile(document.filePath);
    services.signatures.checkAside(content, document.id, 'document-server');
    return reply.type(DOCX_CONTENT_TYPE).send(content);
  });

  app.post<{ Params: DocumentParams }>(`${INTERNAL_DOCUMENTS_PATH}/:id/callback`, async (request, reply) => {
    const callback = await readVerifiedCallback(
      request.body,
      request.headers.authorization,
      config.onlyofficeJwtSecret,
    );
    if (callback === null) {
      request.log.warn({ documentId: request.params.id }, 'Rejected an unsigned or invalid callback');
      return reply.code(401).send(CALLBACK_FAILED);
    }
    if (callback.joined.length > 0) {
      admitInBackground(config, services.editingSessions, request.log, request.params.id, callback);
    }
    const saved = await inArrivalOrder(request.params.id, async () => storeCallbackFile(config, services, request.log, request.params.id, callback));
    if (saved === 'failed') {
      request.log.error({ documentId: request.params.id, status: callback.status }, 'Saving the document failed');
      return reply.send(CALLBACK_FAILED);
    }
    return reply.send(CALLBACK_RECEIVED);
  });

  return app;
}

type CallbackOutcome = 'saved' | 'ignored' | 'failed';

// The Document Server may call back for a document while an earlier callback
// is still downloading or writing it. Each document's callbacks run one at a
// time, in arrival order, so that an older snapshot never replaces a newer one
// and a callback from an ended session meets the new key.
const callbackQueues = new Map<string, Promise<unknown>>();

async function inArrivalOrder<T>(documentId: string, task: () => Promise<T>): Promise<T> {
  const previous = callbackQueues.get(documentId) ?? Promise.resolve();
  const run = runAfter(previous, task);
  // The caller receives the task's failure; the queue only waits for it.
  const settled = run.catch(() => null);
  callbackQueues.set(documentId, settled);
  try {
    return await run;
  } finally {
    if (callbackQueues.get(documentId) === settled) {
      callbackQueues.delete(documentId);
    }
  }
}

async function runAfter<T>(previous: Promise<unknown>, task: () => Promise<T>): Promise<T> {
  await previous;
  return task();
}

// Whoever joins a session is decided again, against the stored base label:
// the Document Server waits for the callback's answer, so this runs aside.
function admitInBackground(
  config: PortalConfig,
  editingSessions: EditingSessions,
  log: FastifyBaseLogger,
  documentId: string,
  callback: CallbackPayload,
): void {
  const admit = async (): Promise<void> => {
    const document = await findDocument(config.documentsDirectory, documentId);
    if (document !== null) {
      await editingSessions.admit(document, callback.key, callback.joined);
    }
  };
  admit().catch((error: unknown) => {
    log.error({ documentId, err: error }, 'The people joining an editing session could not be checked');
  });
}

async function storeCallbackFile(
  config: PortalConfig,
  services: SaveServices,
  log: FastifyBaseLogger,
  documentId: string,
  callback: CallbackPayload,
): Promise<CallbackOutcome> {
  const { editingSessions } = services;
  // The last save of a session the portal ended comes under its old key, and
  // no newer session has started without it.
  const lastOfEnded = editingSessions.retiringKey(documentId) === callback.key;
  if (lastOfEnded && callback.status === CALLBACK_STATUS.closedWithoutChanges) {
    editingSessions.retired(documentId);
    return 'ignored';
  }
  const kind = saveKindOf(callback);
  if (kind === null) {
    return 'ignored';
  }
  if (callback.url === null) {
    return 'failed';
  }
  // A callback for another key belongs to an earlier session: saving it would
  // overwrite a newer version.
  const document = await findDocument(config.documentsDirectory, documentId);
  if (document === null || (document.key !== callback.key && !lastOfEnded)) {
    return 'ignored';
  }
  const response = await fetch(toInternalUrl(callback.url, config.onlyofficeInternalUrl));
  if (!response.ok) {
    return 'failed';
  }
  const content = await services.signatures.signed(await refreshBinding(new Uint8Array(await response.arrayBuffer())), documentId);
  // Reading the labels must not cost the save: unreadable ones skip the log.
  const [before, after] = await Promise.all([
    readLabels(log, documentId, async () => fileLabelsOf(await readFile(document.filePath))),
    readLabels(log, documentId, async () => fileLabelsOf(content)),
  ]);
  // The Document Server names only the last editor of a save: the people
  // who held a configuration for the session may have made the change too.
  const sessionUsers = [...new Set([...callback.users, ...editingSessions.holdersOf(callback.key)])];
  // The document already moved to a new key when its session was ended.
  const saved = await saveDocumentContent(config.documentsDirectory, documentId, content, lastOfEnded ? 'forced' : kind);
  if (saved === null) {
    return 'failed';
  }
  if (before !== null && after !== null) {
    // Logged in the background: the Document Server waits for this answer.
    services.journal.recordSave(documentId, before, after, sessionUsers).catch((error: unknown) => {
      log.error({ documentId, err: error }, 'The lowering of a label could not be checked');
    });
  }
  const labelChanged = before === null || after === null ? before !== after : before.base !== after.base;
  followEditingSession(config, editingSessions, log, callback, { kind, lastOfEnded, labelChanged, saved });
  return 'saved';
}

interface StoredSave {
  kind: SaveKind;
  lastOfEnded: boolean;
  labelChanged: boolean;
  saved: StoredDocument;
}

// Keeps the editing sessions in step with what was stored: a session that
// ended frees its key, and a session going on under a new base label ends
// when that label excludes someone who may join it.
function followEditingSession(
  config: PortalConfig,
  editingSessions: EditingSessions,
  log: FastifyBaseLogger,
  callback: CallbackPayload,
  { kind, lastOfEnded, labelChanged, saved }: StoredSave,
): void {
  if (lastOfEnded && kind === 'session-ended') {
    editingSessions.retired(saved.id);
  } else if (kind === 'session-ended') {
    editingSessions.forget(callback.key);
  } else if (labelChanged && !lastOfEnded) {
    // Checked in the background: the Document Server waits for this answer.
    editingSessions
      .endIfExcluded(saved, callback.key, async () => moveDocumentToNewKey(config.documentsDirectory, saved.id))
      .catch((error: unknown) => {
        log.error({ documentId: saved.id, err: error }, 'An editing session could not be checked against a new base label');
      });
  }
}

// Null when the labels cannot be read.
async function readLabels(log: FastifyBaseLogger, documentId: string, read: () => Promise<FileLabels>): Promise<FileLabels | null> {
  try {
    return await read();
  } catch (error: unknown) {
    log.error({ documentId, err: error }, 'The labels of a document could not be read');
    return null;
  }
}

function saveKindOf(callback: CallbackPayload): SaveKind | null {
  switch (callback.status) {
    case CALLBACK_STATUS.readyForSaving:
      return 'session-ended';
    case CALLBACK_STATUS.forceSaved:
      return 'forced';
    default:
      return null;
  }
}
