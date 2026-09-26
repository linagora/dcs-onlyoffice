import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance } from 'fastify';
import { OidcClient } from './auth/oidc.ts';
import { registerAuth, requireSession } from './auth/routes.ts';
import { SessionStore } from './auth/sessions.ts';
import type { PortalConfig } from './config.ts';
import {
  createDocumentFromTemplate,
  findDocument,
  listDocuments,
  listTemplates,
  type SaveKind,
  saveDocumentContent,
} from './documents.ts';
import { buildEditorConfig, signEditorConfig } from './editor-config.ts';
import {
  type CallbackPayload,
  readVerifiedCallback,
  requestForceSave,
  toInternalUrl,
  verifyOnlyofficeToken,
} from './onlyoffice.ts';
import { renderDocumentListPage, renderEditorPage } from './pages.ts';

interface DocumentParams {
  id: string;
}

interface CreateDocumentBody {
  template?: string;
}

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function buildServer(config: PortalConfig): FastifyInstance {
  const app = fastify({ logger: true, trustProxy: true });

  app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'public'),
    prefix: '/static/',
  });
  app.register(fastifyCookie);
  registerAuth(app, {
    oidc: new OidcClient(config.oidc),
    sessions: new SessionStore(SESSION_LIFETIME_MS),
    portalPublicUrl: config.portalPublicUrl,
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/', async (request, reply) => {
    const session = requireSession(request);
    const [documents, templates] = await Promise.all([
      listDocuments(config.documentsDirectory),
      listTemplates(config.templatesDirectory),
    ]);
    return reply.type('text/html; charset=utf-8').send(renderDocumentListPage(session.user, documents, templates));
  });

  app.get('/api/me', async (request) => requireSession(request).user);

  app.post<{ Body: CreateDocumentBody }>('/documents', async (request, reply) => {
    const templateId = request.body.template ?? '';
    const document = await createDocumentFromTemplate(config.documentsDirectory, config.templatesDirectory, templateId);
    if (document === null) {
      return reply.code(400).send({ error: 'Unknown template' });
    }
    return reply.redirect(`/documents/${document.id}/edit`, 303);
  });

  app.get<{ Params: DocumentParams }>('/documents/:id/edit', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const { user } = requireSession(request);
    const editorConfig = await signEditorConfig(
      buildEditorConfig(document, { id: user.id, name: user.name }, config),
      config.onlyofficeJwtSecret,
    );
    return reply.type('text/html; charset=utf-8').send(
      renderEditorPage({
        title: document.fileName,
        apiScriptUrl: `${config.docsPublicUrl}/web-apps/apps/api/documents/api.js`,
        editorConfig,
      }),
    );
  });

  app.get<{ Params: DocumentParams }>('/documents/:id/download', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    return reply
      .type(DOCX_CONTENT_TYPE)
      .header('Content-Disposition', `attachment; filename="${document.fileName}"`)
      .send(createReadStream(document.filePath));
  });

  app.post<{ Params: DocumentParams }>('/documents/:id/forcesave', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const outcome = await requestForceSave(config.onlyofficeInternalUrl, document.key, config.onlyofficeJwtSecret);
    return reply.code(outcome === 'failed' ? 502 : 202).send({ outcome });
  });

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
      return reply.code(401).send({ error: 1 });
    }
    const saved = await storeCallbackFile(config, request.params.id, callback);
    if (saved === 'failed') {
      request.log.error({ documentId: request.params.id, status: callback.status }, 'Saving the document failed');
      return reply.send({ error: 1 });
    }
    return reply.send({ error: 0 });
  });

  return app;
}

type CallbackOutcome = 'saved' | 'ignored' | 'failed';

// With JWT enabled, the Document Server signs its requests to the document URL.
async function isSignedByDocumentServer(authorization: string | undefined, secret: string): Promise<boolean> {
  if (authorization?.startsWith('Bearer ') !== true) {
    return false;
  }
  return (await verifyOnlyofficeToken(authorization.slice('Bearer '.length), secret)) !== null;
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
  const saved = await saveDocumentContent(
    config.documentsDirectory,
    documentId,
    new Uint8Array(await response.arrayBuffer()),
    kind,
  );
  return saved === null ? 'failed' : 'saved';
}

function saveKindOf(callback: CallbackPayload): SaveKind | null {
  switch (callback.status) {
    case 2:
      return 'session-ended';
    case 6:
      return 'forced';
    default:
      return null;
  }
}
