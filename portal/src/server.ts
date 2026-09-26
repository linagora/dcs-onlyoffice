import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OidcClient } from './auth/oidc.ts';
import { refreshBindingReferences } from './binding.ts';
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
import { buildEditorConfig, type EditorMode, type EditorPlugin, signEditorConfig } from './editor-config.ts';
import {
  bearerToken,
  CALLBACK_FAILED,
  CALLBACK_RECEIVED,
  CALLBACK_STATUS,
  type CallbackPayload,
  readVerifiedCallback,
  requestForceSave,
  toInternalUrl,
  verifyOnlyofficeToken,
} from './onlyoffice.ts';
import { renderDocumentListPage, renderEditorPage } from './pages.ts';
import { registerPolicyRelay } from './policy-relay.ts';

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
  const plugin = loadEditorPlugin(config);

  app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'public'),
    prefix: '/static/',
  });
  // The editor derives the plugin's base URL by cutting "config.json" out of
  // this URL, so the read-only variant (EditorPlugin.viewConfigUrl) keeps the
  // same path and differs by its query.
  app.get<{ Querystring: { mode?: string } }>('/plugin/config.json', async (request, reply) =>
    reply
      .header('Access-Control-Allow-Origin', config.docsPublicUrl)
      .type('application/json; charset=utf-8')
      .send(request.query.mode === 'view' ? viewModeManifest(config) : readPluginManifest(config)),
  );
  // The editor, on the Document Server's origin, fetches the plugin
  // configuration with an XHR; the plugin page itself runs on this origin.
  app.register(fastifyStatic, {
    root: config.pluginDirectory,
    prefix: '/plugin/',
    decorateReply: false,
    setHeaders: (reply) => {
      reply.header('Access-Control-Allow-Origin', config.docsPublicUrl);
    },
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

function readPluginManifest(config: PortalConfig): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(path.join(config.pluginDirectory, 'config.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('guid' in manifest) || typeof manifest.guid !== 'string') {
    throw new Error(`The plugin configuration in ${config.pluginDirectory} has no guid`);
  }
  return manifest as Record<string, unknown>; // SAFETY: object with a guid checked above
}

function loadEditorPlugin(config: PortalConfig): EditorPlugin {
  return {
    guid: String(readPluginManifest(config).guid),
    configUrl: `${config.portalPublicUrl}/plugin/config.json`,
    viewConfigUrl: `${config.portalPublicUrl}/plugin/config.json?mode=view`,
  };
}

function viewModeManifest(config: PortalConfig): Record<string, unknown> {
  const manifest = readPluginManifest(config);
  const variations = Array.isArray(manifest.variations) ? manifest.variations : [];
  return {
    ...manifest,
    variations: variations.map((variation: unknown) =>
      typeof variation === 'object' && variation !== null ? { ...variation, type: 'panel' } : variation,
    ),
  };
}

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
