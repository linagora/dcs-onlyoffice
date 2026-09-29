import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AccessTokens } from './auth/access-tokens.ts';
import { OidcClient } from './auth/oidc.ts';
import { registerAuth, requireSession } from './auth/routes.ts';
import { SessionStore, type UserIdentity } from './auth/sessions.ts';
import { BindingSignatures } from './binding-signature.ts';
import { registerClearanceAdmin } from './clearance-admin.ts';
import type { PortalConfig } from './config.ts';
import { LabelJournal, type PortionState } from './label-journal.ts';
import { type DocumentDecision, DocumentAccessCheck } from './document-access.ts';
import { BaseLabels } from './document-labels.ts';
import { registerDocumentServerRoutes } from './document-server-routes.ts';
import { EditingSessions } from './editing-sessions.ts';
import { createDocumentFromTemplate, DOCUMENT_FORMATS, fileNameOf, findDocument, listDocuments, listTemplates } from './documents.ts';
import { buildEditorConfig, type EditorMode, isEditorLanguage, signEditorConfig } from './editor-config.ts';
import { type CommandService, requestForceSave } from './onlyoffice.ts';
import { registerOpentdfRelay } from './opentdf-relay.ts';
import { renderDocumentListPage, renderEditorPage, renderRestrictedDocumentPage, renderSavingDocumentPage } from './pages.ts';
import { registerPluginRoutes } from './plugin-routes.ts';
import { registerPolicyRelay } from './policy-relay.ts';
import { labelsForUpload, registerUploads, UPLOAD_LIMIT_MEGABYTES } from './uploads.ts';

interface DocumentParams {
  id: string;
}

interface EditorRoute {
  Params: DocumentParams;
  // Unchecked input: a repeated parameter arrives as an array.
  Querystring: { lang?: unknown };
}

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const FORCE_SAVE_ATTEMPTS = 10;
const FORCE_SAVE_RETRY_MS = 500;

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

  const baseLabels = new BaseLabels();
  const documentAccess = new DocumentAccessCheck(config.policyInternalUrl, baseLabels, app.log);
  const labelJournal = new LabelJournal(config.policyInternalUrl, app.log);
  const bindingSignatures = new BindingSignatures(config.policyInternalUrl, config.bindingSignatureSecret, app.log);
  const commands: CommandService = { internalUrl: config.onlyofficeInternalUrl, secret: config.onlyofficeJwtSecret };
  const editingSessions = new EditingSessions(commands, documentAccess, app.log);
  // A document the person may not open answers every address the same way,
  // without its name.
  const refuse = (reply: FastifyReply, user: UserIdentity, decision: Exclude<DocumentDecision, { open: true }>): FastifyReply =>
    reply
      .code(decision.reason === 'clearance' ? 403 : 503)
      .type('text/html; charset=utf-8')
      .send(renderRestrictedDocumentPage(user, decision));

  app.get('/', async (request, reply) => {
    const session = requireSession(request);
    const [documents, templates, uploadLabels] = await Promise.all([
      listDocuments(config.documentsDirectory),
      listTemplates(config.templatesDirectory),
      labelsForUpload(config.policyInternalUrl, session.user, request.log),
    ]);
    baseLabels.retain(new Set(documents.map((document) => document.id)));
    const decisions = await documentAccess.decide(session.user, documents);
    const listed = documents.map((document, index) => ({ document, decision: decisions[index] ?? { open: false, reason: 'unavailable' } as const }));
    return reply
      .type('text/html; charset=utf-8')
      .send(renderDocumentListPage(session.user, listed, templates, { labels: uploadLabels, limitMegabytes: UPLOAD_LIMIT_MEGABYTES }));
  });

  app.get('/api/me', async (request) => requireSession(request).user);
  registerPolicyRelay(app, { policyInternalUrl: config.policyInternalUrl, documentsDirectory: config.documentsDirectory, documentAccess });
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
  registerUploads(app, {
    policyInternalUrl: config.policyInternalUrl,
    documentsDirectory: config.documentsDirectory,
    signatures: bindingSignatures,
    journal: labelJournal,
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
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return refuse(reply, user, decision);
    }
    // A session the portal ended may still send its last save: a newer
    // session would start without it.
    if (editingSessions.isRetiring(document.id)) {
      return reply.code(503).header('Retry-After', '2').type('text/html; charset=utf-8').send(renderSavingDocumentPage(user));
    }
    const editorConfig = await signEditorConfig(
      buildEditorConfig(document, { id: user.id, name: user.name }, plugin, mode, language, config),
      config.onlyofficeJwtSecret,
    );
    editingSessions.remember(document.key, user);
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
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return refuse(reply, user, decision);
    }
    const content = await readFile(document.filePath);
    bindingSignatures.checkAside(content, document, 'download');
    return reply
      .type(DOCUMENT_FORMATS[document.format].contentType)
      .header('Content-Disposition', attachment(document.fileName, fileNameOf(document.id, document.format)))
      .send(content);
  });

  app.post<{ Params: DocumentParams }>('/documents/:id/forcesave', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const decision = await documentAccess.decideOne(requireSession(request).user, document);
    if (!decision.open) {
      return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
    }
    const outcome = await requestForceSave(commands, document.key);
    return reply.code(outcome === 'failed' ? 502 : 202).send({ outcome });
  });

  // The panel reports each change of a portion it makes, of its text, its
  // label or both, which the portal logs with the person who made it.
  app.post<{ Params: DocumentParams }>('/documents/:id/portion-change', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    const change = readPortionChange(request.body);
    if (document === null || change === null) {
      return reply.code(document === null ? 404 : 400).send({ error: document === null ? 'Document not found' : 'Expected { portion, before, after }' });
    }
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
    }
    await labelJournal.recordPortionReport({ documentId: document.id, ...change }, user.id);
    return reply.code(204).send();
  });

  // The panel reports each portion it deletes, which the portal logs with the
  // person who deleted it.
  app.post<{ Params: DocumentParams }>('/documents/:id/portion-deletion', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    const deletion = readPortionDeletion(request.body);
    if (document === null || deletion === null) {
      return reply.code(document === null ? 404 : 400).send({ error: document === null ? 'Document not found' : 'Expected { portion, before }' });
    }
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
    }
    labelJournal.recordPortionDeletion({ documentId: document.id, ...deletion }, user.id);
    return reply.code(204).send();
  });

  // The panel reports the base label changes it makes, which the portal logs
  // with the person who made them, and saves the document at once: until
  // then, whoever opens it would still be checked against the stored label.
  app.post<{ Params: DocumentParams }>('/documents/:id/base-label', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    const change = readBaseLabelChange(request.body);
    if (document === null || change === null) {
      return reply.code(document === null ? 404 : 400).send({ error: document === null ? 'Document not found' : 'Expected { before, after }' });
    }
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
    }
    await labelJournal.recordBaseLabelReport({ documentId: document.id, ...change }, user.id);
    // The change reaches the Document Server through the editor's websocket,
    // which may come after this request: until then, it has nothing to save.
    let outcome = await requestForceSave(commands, document.key);
    for (let attempt = 1; outcome === 'no-changes' && attempt < FORCE_SAVE_ATTEMPTS; attempt += 1) {
      await setTimeout(FORCE_SAVE_RETRY_MS);
      outcome = await requestForceSave(commands, document.key);
    }
    return reply.code(outcome === 'failed' ? 502 : 202).send({ outcome });
  });

  registerDocumentServerRoutes(app, config, { signatures: bindingSignatures, journal: labelJournal, editingSessions });

  return app;
}

function readPortionChange(body: unknown): { portion: string; before: PortionState; after: PortionState } | null {
  if (typeof body !== 'object' || body === null || !('portion' in body) || !('before' in body) || !('after' in body)) {
    return null;
  }
  const { portion, before, after } = body;
  const [stateBefore, stateAfter] = [readPortionState(before), readPortionState(after)];
  return typeof portion === 'string' && stateBefore !== null && stateAfter !== null ? { portion, before: stateBefore, after: stateAfter } : null;
}

function readPortionDeletion(body: unknown): { portion: string; before: PortionState } | null {
  if (typeof body !== 'object' || body === null || !('portion' in body) || !('before' in body)) {
    return null;
  }
  const { portion } = body;
  const before = readPortionState(body.before);
  return typeof portion === 'string' && before !== null ? { portion, before } : null;
}

function readPortionState(value: unknown): PortionState | null {
  if (typeof value !== 'object' || value === null || !('label' in value) || typeof value.label !== 'string' || !('version' in value)) {
    return null;
  }
  const { version } = value;
  return version === null || Number.isInteger(version) ? { label: value.label, version: version === null ? null : Number(version) } : null;
}

function readBaseLabelChange(body: unknown): { before: string | null; after: string | null } | null {
  if (typeof body !== 'object' || body === null || !('before' in body) || !('after' in body)) {
    return null;
  }
  const { before, after } = body;
  const isCode = (value: unknown): value is string | null => value === null || typeof value === 'string';
  return isCode(before) && isCode(after) ? { before, after } : null;
}

// A download's Content-Disposition (RFC 6266): the name in ASCII for older
// clients, then in UTF-8 (RFC 8187), since an uploaded file keeps its own.
function attachment(fileName: string, asciiName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}
