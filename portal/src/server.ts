import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AccessTokens } from './auth/access-tokens.ts';
import { OidcClient } from './auth/oidc.ts';
import { registerAuth, requireSession } from './auth/routes.ts';
import { SessionStore } from './auth/sessions.ts';
import { registerClearanceAdmin } from './clearance-admin.ts';
import type { PortalConfig } from './config.ts';
import { registerDocumentServerRoutes } from './document-server-routes.ts';
import { createDocumentFromTemplate, DOCX_CONTENT_TYPE, findDocument, listDocuments, listTemplates } from './documents.ts';
import { buildEditorConfig, type EditorMode, isEditorLanguage, signEditorConfig } from './editor-config.ts';
import { requestForceSave } from './onlyoffice.ts';
import { registerOpentdfRelay } from './opentdf-relay.ts';
import { renderDocumentListPage, renderEditorPage } from './pages.ts';
import { registerPluginRoutes } from './plugin-routes.ts';
import { registerPolicyRelay } from './policy-relay.ts';

interface DocumentParams {
  id: string;
}

interface EditorRoute {
  Params: DocumentParams;
  // Unchecked input: a repeated parameter arrives as an array.
  Querystring: { lang?: unknown };
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
  const oidc = new OidcClient(config.oidc);
  const sessions = new SessionStore(SESSION_LIFETIME_MS);
  registerAuth(app, { oidc, sessions, portalPublicUrl: config.portalPublicUrl });
  // HTML forms: a field sent several times, such as a list of checkboxes,
  // keeps every value.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, new URLSearchParams(String(body)));
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
  registerClearanceAdmin(app, {
    policyInternalUrl: config.policyInternalUrl,
    portalPublicUrl: config.portalPublicUrl,
    administrationSecret: config.directoryAdministrationSecret,
  });
  registerOpentdfRelay(app, { opentdfInternalUrl: config.opentdfInternalUrl, accessTokens: new AccessTokens(oidc, sessions) });

  app.post('/documents', async (request, reply) => {
    const templateId = request.body instanceof URLSearchParams ? (request.body.get('template') ?? '') : '';
    const document = await createDocumentFromTemplate(config.documentsDirectory, config.templatesDirectory, templateId);
    if (document === null) {
      return reply.code(400).send({ error: 'Unknown template' });
    }
    return reply.redirect(`/documents/${document.id}/edit`, 303);
  });

  const openEditor = (mode: EditorMode) => async (request: FastifyRequest<EditorRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    // A language in the address applies to this editing session only.
    const language = request.query.lang ?? config.editorLanguage;
    if (!isEditorLanguage(language)) {
      return reply.code(400).send({ error: 'Unsupported language' });
    }
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const { user } = requireSession(request);
    const editorConfig = await signEditorConfig(
      buildEditorConfig(document, { id: user.id, name: user.name }, plugin, mode, language, config),
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
  app.get<EditorRoute>('/documents/:id/edit', openEditor('edit'));
  app.get<EditorRoute>('/documents/:id/view', openEditor('view'));

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
