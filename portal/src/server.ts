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
import { Journal } from './journal.ts';
import { registerJournalAdmin } from './journal-admin.ts';
import { LabelJournal, type PortionState } from './label-journal.ts';
import { type DocumentDecision, DocumentAccessCheck } from './document-access.ts';
import { StoredLabels, storedPortionPartOf } from './document-labels.ts';
import { registerDocumentServerRoutes } from './document-server-routes.ts';
import { EditingSessions } from './editing-sessions.ts';
import {
  createDocumentFromTemplate,
  DOCUMENT_FORMATS,
  fileNameOf,
  findDocument,
  latestSignatureOf,
  listDocuments,
  listTemplates,
  moveDocumentToNewKey,
} from './documents.ts';
import { buildEditorConfig, type EditorMode, isEditorLanguage, signEditorConfig } from './editor-config.ts';
import { type CommandService, requestForceSave } from './onlyoffice.ts';
import { registerOpentdfRelay } from './opentdf-relay.ts';
import { renderDocumentListPage, renderEditorPage, renderPortionPage, renderRestrictedDocumentPage, renderSavingDocumentPage } from './pages.ts';
import { registerPluginRoutes } from './plugin-routes.ts';
import { registerPolicyRelay } from './policy-relay.ts';
import { labelsForUpload, registerUploads, UPLOAD_LIMIT_MEGABYTES } from './uploads.ts';

interface DocumentParams {
  id: string;
}

interface PortionParams {
  id: string;
  portion: string;
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

  const storedLabels = new StoredLabels();
  const documentAccess = new DocumentAccessCheck(config.policyInternalUrl, storedLabels, app.log);
  const journal = new Journal(config.journalDatabase, app.log);
  app.addHook('onClose', async () => journal.close());
  const labelJournal = new LabelJournal(config.policyInternalUrl, journal, app.log);
  const bindingSignatures = new BindingSignatures(config.policyInternalUrl, config.bindingSignatureSecret, journal, app.log, async (id) =>
    latestSignatureOf(config.documentsDirectory, id),
  );
  const commands: CommandService = { internalUrl: config.onlyofficeInternalUrl, secret: config.onlyofficeJwtSecret };
  const editingSessions = new EditingSessions(
    commands,
    documentAccess,
    {
      find: async (id) => findDocument(config.documentsDirectory, id),
      moveToNewKey: async (id, fromKey) => moveDocumentToNewKey(config.documentsDirectory, id, fromKey),
    },
    journal,
    app.log,
  );
  // Every so often, the portal checks the clearances of the people who hold
  // an editing session's configuration: an expiry, or a change made in the
  // clearance directory itself, applies within the interval.
  const clearanceCheck = setInterval(() => {
    editingSessions.checkClearances().catch((error: unknown) => {
      app.log.error({ err: error }, 'The editing sessions could not be checked against the clearances');
    });
  }, config.clearanceCheckSeconds * 1_000);
  app.addHook('onClose', async () => {
    clearInterval(clearanceCheck);
  });
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
    storedLabels.retain(new Set(documents.map((document) => document.id)));
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
    journal,
    editingSessions,
  });
  registerJournalAdmin(app, journal);
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
    labelJournal,
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
    editingSessions.remember(document, user);
    const screenMarking = DOCUMENT_FORMATS[document.format].screenMarked ? { initial: await documentAccess.documentLabelMarkingOf(user, document) } : null;
    return reply.type('text/html; charset=utf-8').send(
      renderEditorPage({
        title: document.fileName,
        apiScriptUrl: `${config.docsPublicUrl}/web-apps/apps/api/documents/api.js`,
        editorConfig,
        screenMarking,
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
    bindingSignatures.checkAside(content, document, 'download', user);
    return reply
      .type(DOCUMENT_FORMATS[document.format].contentType)
      .header('Content-Disposition', attachment(document.fileName, fileNameOf(document.id, document.format)))
      .send(content);
  });

  // A protected portion read outside the editor, on its portion page. The
  // portal decides on the document as it does to open it, and hands the page
  // the portion's part as stored, envelope and all: the reader's browser
  // opens the envelope, and OpenTDF decides on the portion at each opening.
  app.get<{ Params: PortionParams }>('/documents/:id/portions/:portion', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return refuse(reply, user, decision);
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(renderPortionPage(user, { document, portionId: request.params.portion, opentdfUrl: config.opentdfPublicUrl }));
  });

  app.get<{ Params: PortionParams }>('/documents/:id/portions/:portion/part', async (request, reply) => {
    const document = await findDocument(config.documentsDirectory, request.params.id);
    if (document === null) {
      return reply.code(404).send({ error: 'Document not found' });
    }
    const { user } = requireSession(request);
    const decision = await documentAccess.decideOne(user, document);
    if (!decision.open) {
      return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
    }
    const stored = await storedPortionPartOf(await readFile(document.filePath), request.params.portion);
    return stored ?? reply.code(404).send({ error: 'The stored document holds no such portion' });
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

  // The panel reports what it does to portions, which the portal logs with
  // the person who did it, from a person who may open the document.
  const reportRoute = <Report extends object>(
    report: string,
    read: (body: unknown) => Report | null,
    expected: string,
    record: (entry: Report & { documentId: string }, user: UserIdentity) => Promise<void> | void,
  ): void => {
    app.post<{ Params: DocumentParams }>(`/documents/:id/${report}`, async (request, reply) => {
      const document = await findDocument(config.documentsDirectory, request.params.id);
      const body = read(request.body);
      if (document === null || body === null) {
        return reply.code(document === null ? 404 : 400).send({ error: document === null ? 'Document not found' : `Expected ${expected}` });
      }
      const { user } = requireSession(request);
      const decision = await documentAccess.decideOne(user, document);
      if (!decision.open) {
        return reply.code(decision.reason === 'clearance' ? 403 : 503).send({ error: 'Access denied' });
      }
      await record({ documentId: document.id, ...body }, user);
      return reply.code(204).send();
    });
  };
  // Each change of a portion, of its text, its label or both.
  reportRoute('portion-change', readPortionChange, '{ portion, before, after }', async (change, user) => labelJournal.recordPortionReport(change, user));
  // Each portion deleted.
  reportRoute('portion-deletion', readPortionDeletion, '{ portion, before }', (deletion, user) => {
    labelJournal.recordPortionDeletion(deletion, user);
  });
  // Each protection of content already in the document, as a new portion.
  reportRoute('existing-content-protection', readExistingContentProtection, '{ portion, after }', (protection, user) => {
    labelJournal.recordExistingContentProtection(protection, user);
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
    await labelJournal.recordBaseLabelReport({ documentId: document.id, ...change }, user);
    // The change reaches the Document Server through the editor's websocket,
    // which may come after this request: until then, it has nothing to save.
    let outcome = await requestForceSave(commands, document.key);
    for (let attempt = 1; outcome === 'no-changes' && attempt < FORCE_SAVE_ATTEMPTS; attempt += 1) {
      await setTimeout(FORCE_SAVE_RETRY_MS);
      outcome = await requestForceSave(commands, document.key);
    }
    return reply.code(outcome === 'failed' ? 502 : 202).send({ outcome });
  });

  registerDocumentServerRoutes(app, config, { signatures: bindingSignatures, labelJournal, editingSessions });

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

function readExistingContentProtection(body: unknown): { portion: string; after: PortionState } | null {
  if (typeof body !== 'object' || body === null || !('portion' in body) || !('after' in body)) {
    return null;
  }
  const { portion } = body;
  const after = readPortionState(body.after);
  return typeof portion === 'string' && after !== null ? { portion, after } : null;
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
