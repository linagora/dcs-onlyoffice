import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { refreshBindingReferences } from './binding.ts';
import type { PortalConfig } from './config.ts';
import { DOCX_CONTENT_TYPE, findDocument, type SaveKind, saveDocumentContent } from './documents.ts';
import {
  bearerToken,
  CALLBACK_FAILED,
  CALLBACK_RECEIVED,
  CALLBACK_STATUS,
  type CallbackPayload,
  readVerifiedCallback,
  toInternalUrl,
  verifyOnlyofficeToken,
} from './onlyoffice.ts';

interface DocumentParams {
  id: string;
}

// Routes the Document Server calls to load and save documents.
export function registerDocumentServerRoutes(app: FastifyInstance, config: PortalConfig): FastifyInstance {
  // Routes under /internal are only reachable from the Compose network: the
  // reverse proxy refuses them.
  app.get<{ Params: DocumentParams }>('/internal/documents/:id/content', async (request, reply) => {
    if (!(await isSignedByDocumentServer(request.headers.authorization, config.onlyofficeJwtSecret))) {
      request.log.warn({ documentId: request.params.id }, 'Rejected an unsigned document download');
      return reply.code(401).send({ error: 'Unsigned request' });
    }
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    return reply.type(DOCX_CONTENT_TYPE).send(createReadStream(document.filePath));
  });

  app.post<{ Params: DocumentParams }>('/internal/documents/:id/callback', async (request, reply) => {
    const callback = await readVerifiedCallback(
      request.body,
      request.headers.authorization,
      config.onlyofficeJwtSecret,
    );
    if (callback === null) {
      request.log.warn({ documentId: request.params.id }, 'Rejected an unsigned or invalid callback');
      return reply.code(401).send(CALLBACK_FAILED);
    }
    const saved = await storeCallbackFile(config, request.params.id, callback);
    if (saved === 'failed') {
      request.log.error({ documentId: request.params.id, status: callback.status }, 'Saving the document failed');
      return reply.send(CALLBACK_FAILED);
    }
    return reply.send(CALLBACK_RECEIVED);
  });

  return app;
}

type CallbackOutcome = 'saved' | 'ignored' | 'failed';

// With JWT enabled, the Document Server signs its requests to the document URL.
async function isSignedByDocumentServer(authorization: string | undefined, secret: string): Promise<boolean> {
  const token = bearerToken(authorization);
  return token !== null && (await verifyOnlyofficeToken(token, secret)) !== null;
}

async function storeCallbackFile(config: PortalConfig, documentId: string, callback: CallbackPayload): Promise<CallbackOutcome> {
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
  const saved = await saveDocumentContent(config.documentsDirectory, documentId, content, kind);
  return saved === null ? 'failed' : 'saved';
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
