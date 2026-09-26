import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OidcClient } from './auth/oidc.ts';
import { registerAuth, requireSession } from './auth/routes.ts';
import { SessionStore } from './auth/sessions.ts';
import type { PortalConfig } from './config.ts';
import { registerDocumentServerRoutes } from './document-server-routes.ts';
import { createDocumentFromTemplate, DOCX_CONTENT_TYPE, findDocument, listDocuments, listTemplates } from './documents.ts';
import { buildEditorConfig, type EditorMode, signEditorConfig } from './editor-config.ts';
import { requestForceSave } from './onlyoffice.ts';
import { renderDocumentListPage, renderEditorPage } from './pages.ts';
import { registerPluginRoutes } from './plugin-routes.ts';
import { registerPolicyRelay } from './policy-relay.ts';

interface DocumentParams {
  id: string;
}

interface CreateDocumentBody {
  template?: string;
}

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function buildServer(config: PortalConfig): FastifyInstance {
  const app = fastify({ logger: true, trustProxy: true });

  app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'public'),
    prefix: '/static/',
  });
  const plugin = registerPluginRoutes(app, config);
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
  registerPolicyRelay(app, config.policyInternalUrl);

  app.post<{ Body: CreateDocumentBody }>('/documents', async (request, reply) => {
    const templateId = request.body.template ?? '';
    const document = await createDocumentFromTemplate(config.documentsDirectory, config.templatesDirectory, templateId);
    if (document === null) {
      return reply.code(400).send({ error: 'Unknown template' });
    }
    return reply.redirect(`/documents/${document.id}/edit`, 303);
  });

  const openEditor = (mode: EditorMode) => async (request: FastifyRequest<{ Params: DocumentParams }>, reply: FastifyReply): Promise<FastifyReply> => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const { user } = requireSession(request);
    const editorConfig = await signEditorConfig(
      buildEditorConfig(document, { id: user.id, name: user.name }, plugin, mode, config),
      config.onlyofficeJwtSecret,
    );
    return reply.type('text/html; charset=utf-8').send(
      renderEditorPage({
        title: document.fileName,
        apiScriptUrl: `${config.docsPublicUrl}/web-apps/apps/api/documents/api.js`,
        editorConfig,
      }),
    );
  };
  app.get<{ Params: DocumentParams }>('/documents/:id/edit', openEditor('edit'));
  app.get<{ Params: DocumentParams }>('/documents/:id/view', openEditor('view'));

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

  registerDocumentServerRoutes(app, config);

  return app;
}
