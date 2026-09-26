import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance } from 'fastify';
import type { PortalConfig } from './config.ts';
import { findDocument, listDocuments } from './documents.ts';
import { buildEditorConfig, type EditorUser, signEditorConfig } from './editor-config.ts';
import { renderDocumentListPage, renderEditorPage } from './pages.ts';

interface DocumentParams {
  id: string;
}

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Replaced by the signed-in user once authentication is in place.
const ANONYMOUS_USER: EditorUser = { id: 'anonymous', name: 'Anonymous' };

export function buildServer(config: PortalConfig): FastifyInstance {
  const app = fastify({ logger: true, trustProxy: true });

  app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'public'),
    prefix: '/static/',
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/', async (_request, reply) => {
    const documents = await listDocuments(config.documentsDirectory);
    return reply.type('text/html; charset=utf-8').send(renderDocumentListPage(documents));
  });

  app.get<{ Params: DocumentParams }>('/documents/:id/edit', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const editorConfig = await signEditorConfig(
      buildEditorConfig(document, ANONYMOUS_USER, config),
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

  // Routes under /internal are only reachable from the Compose network: the
  // reverse proxy refuses them.
  app.get<{ Params: DocumentParams }>('/internal/documents/:id/content', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    return reply.type(DOCX_CONTENT_TYPE).send(createReadStream(document.filePath));
  });

  app.post<{ Params: DocumentParams }>('/internal/documents/:id/callback', async () => ({ error: 0 }));

  return app;
}
