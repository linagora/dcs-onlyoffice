import { createReadStream } from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { BaseLabelAudit } from './base-label-audit.ts';
import { refreshBindingReferences } from './binding.ts';
import type { PortalConfig } from './config.ts';
import { type BaseLabels, baseLabelCodeOf } from './document-labels.ts';
import { DOCX_CONTENT_TYPE, findDocument, type SaveKind, saveDocumentContent } from './documents.ts';
import { INTERNAL_DOCUMENTS_PATH, internalDocumentUrl } from './editor-config.ts';
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

// What a save needs to log the lowering of a base label: the stored file's
// label and the audit.
export interface SaveAudit {
  baseLabels: BaseLabels;
  audit: BaseLabelAudit;
}

// Routes the Document Server calls to load and save documents.
export function registerDocumentServerRoutes(app: FastifyInstance, config: PortalConfig, saveAudit: SaveAudit): FastifyInstance {
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
    return reply.type(DOCX_CONTENT_TYPE).send(createReadStream(document.filePath));
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
    const saved = await inArrivalOrder(request.params.id, async () => storeCallbackFile(config, saveAudit, request.log, request.params.id, callback));
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

async function storeCallbackFile(
  config: PortalConfig,
  saveAudit: SaveAudit,
  log: FastifyBaseLogger,
  documentId: string,
  callback: CallbackPayload,
): Promise<CallbackOutcome> {
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
  if (document === null || document.key !== callback.key) {
    return 'ignored';
  }
  const response = await fetch(toInternalUrl(callback.url, config.onlyofficeInternalUrl));
  if (!response.ok) {
    return 'failed';
  }
  const content = await refreshBindingReferences(new Uint8Array(await response.arrayBuffer()));
  // Reading the labels must not cost the save: an unreadable one skips the log.
  const [before, after] = await Promise.all([
    readBaseLabel(log, documentId, async () => saveAudit.baseLabels.of(document)),
    readBaseLabel(log, documentId, async () => baseLabelCodeOf(content)),
  ]);
  const saved = await saveDocumentContent(config.documentsDirectory, documentId, content, kind);
  if (saved !== null && before !== undefined && after !== undefined) {
    // Logged in the background: the Document Server waits for this answer.
    saveAudit.audit.recordSave({ documentId, before, after }, callback.users).catch((error: unknown) => {
      log.error({ documentId, err: error }, 'The lowering of a base label could not be checked');
    });
  }
  return saved === null ? 'failed' : 'saved';
}

// Undefined when the label cannot be read.
async function readBaseLabel(log: FastifyBaseLogger, documentId: string, read: () => Promise<string | null>): Promise<string | null | undefined> {
  try {
    return await read();
  } catch (error: unknown) {
    log.error({ documentId, err: error }, 'A base label could not be read');
    return undefined;
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
