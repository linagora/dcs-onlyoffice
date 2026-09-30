import type { FastifyInstance, FastifyReply } from 'fastify';
import { forbidden, NO_FRAMING } from './administration.ts';
import { isAdministrator } from './auth/administrators.ts';
import { requireSession } from './auth/routes.ts';
import type { UserIdentity } from './auth/sessions.ts';
import type { EditingSessions } from './editing-sessions.ts';
import { type Journal, journalPerson } from './journal.ts';
import { type ClearanceChoices, type ClearanceEntry, type PageNotice, renderClearancesPage } from './pages.ts';
import { identityHeaders } from './policy-relay.ts';
import { firstInstant, instantAfter } from './validity-period.ts';

export interface ClearanceAdminDeps {
  policyInternalUrl: string;
  portalPublicUrl: string;
  // Shared with the policy service, which serves the directory's
  // administration to the portal only.
  administrationSecret: string;
  journal: Journal;
  editingSessions: EditingSessions;
}

// What a clearance lets its holder read, and when.
type ClearanceTerms = Pick<ClearanceEntry, 'classification' | 'categories' | 'validFrom' | 'validUntil'>;

// A clearance change, as the policy service answers it.
interface ClearanceChange {
  before: ClearanceEntry;
  after: ClearanceEntry;
}

// Administrators see and edit every clearance of the directory, which the
// policy service keeps. A change goes into the journal, and applies at once:
// OpenTDF reads it at the next key request, and the portal ends the editing
// sessions that a change letting someone read less excludes them from.
export function registerClearanceAdmin(app: FastifyInstance, deps: ClearanceAdminDeps): FastifyInstance {
  app.get<{ Querystring: { saved?: unknown } }>('/admin/clearances', async (request, reply) => {
    const { user } = requireSession(request);
    if (!isAdministrator(user)) {
      return forbidden(reply);
    }
    const saved = typeof request.query.saved === 'string' ? request.query.saved : null;
    return sendPage(reply, user, deps, { saved, error: null }, 200);
  });

  app.post('/admin/clearances', async (request, reply) => {
    const { user } = requireSession(request);
    // The session cookie is SameSite=Lax, which a sibling host of the same
    // domain still receives with a form: only the portal's own page may write.
    if (request.headers.origin !== deps.portalPublicUrl || !isAdministrator(user)) {
      return forbidden(reply);
    }
    const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
    const email = form.get('email') ?? '';
    const policy = form.get('policy') ?? '';
    const terms: ClearanceTerms = {
      classification: form.get('classification') ?? '',
      categories: form.getAll('category'),
      validFrom: firstInstant(form.get('validFrom'), form.get('validFromWas')),
      validUntil: instantAfter(form.get('validThrough'), form.get('validUntilWas')),
    };
    const response = await fetch(`${deps.policyInternalUrl}/directory/policies/${encodeURIComponent(policy)}/clearances/${encodeURIComponent(email)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(user, deps) },
      body: JSON.stringify(terms),
    });
    if (response.ok) {
      const change = clearanceChangeOf(await response.json());
      deps.journal.record({
        category: 'clearance',
        level: 'info',
        message: 'Clearance changed',
        documentId: null,
        fields: { policy: change.after.policy, before: termsOf(change.before), after: termsOf(change.after) },
        // The directory knows its people by their email address.
        people: [journalPerson('author', user), { role: 'holder', id: change.after.email, name: change.after.name, email: change.after.email }],
      });
      // Checked in the background: the administrator's page does not wait for
      // the Document Server.
      deps.editingSessions.applyClearanceChange(change.after.email).catch((error: unknown) => {
        request.log.error({ err: error, email: change.after.email }, 'The editing sessions could not be checked after a clearance change');
      });
      return reply.redirect(`/admin/clearances?saved=${encodeURIComponent(email)}`, 303);
    }
    const body: unknown = await response.json();
    const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `${response.status}`;
    return sendPage(reply, user, deps, { saved: null, error: `The clearance of ${email} was not saved: ${reason}` }, 422);
  });
  return app;
}

function directoryHeaders(user: UserIdentity, deps: ClearanceAdminDeps): Record<string, string> {
  return { ...identityHeaders(user), Authorization: `Bearer ${deps.administrationSecret}` };
}

async function sendPage(reply: FastifyReply, user: UserIdentity, deps: ClearanceAdminDeps, notice: PageNotice, status: number): Promise<FastifyReply> {
  const entries = entriesOf(await policyJson(`${deps.policyInternalUrl}/directory/clearances`, directoryHeaders(user, deps)));
  const choices = new Map<string, ClearanceChoices>();
  for (const policy of new Set(entries.map((entry) => entry.policy))) {
    // A policy the service no longer holds leaves its entries' own terms.
    const offered = await policyJson(`${deps.policyInternalUrl}/policies/${encodeURIComponent(policy)}/clearance-choices`, identityHeaders(user), true);
    if (offered !== null) {
      choices.set(policy, choicesOf(offered));
    }
  }
  return reply
    .code(status)
    .header('Content-Security-Policy', NO_FRAMING)
    .type('text/html; charset=utf-8')
    .send(renderClearancesPage(user, entries, choices, notice));
}

async function policyJson(url: string, headers: Record<string, string>, absentIfUnknown = false): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (absentIfUnknown && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`The policy service answered ${response.status} for ${url}`);
  }
  return response.json();
}

function entriesOf(body: unknown): ClearanceEntry[] {
  const list: unknown = typeof body === 'object' && body !== null && 'clearances' in body ? body.clearances : null;
  if (!Array.isArray(list) || !list.every(isClearanceEntry)) {
    throw new Error('Unexpected clearance list');
  }
  return list;
}

function clearanceChangeOf(body: unknown): ClearanceChange {
  if (typeof body !== 'object' || body === null || !('before' in body) || !('after' in body) || !isClearanceEntry(body.before) || !isClearanceEntry(body.after)) {
    throw new Error('Unexpected clearance change');
  }
  return { before: body.before, after: body.after };
}

function termsOf(entry: ClearanceEntry): ClearanceTerms {
  return { classification: entry.classification, categories: entry.categories, validFrom: entry.validFrom, validUntil: entry.validUntil };
}

function isClearanceEntry(value: unknown): value is ClearanceEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>; // SAFETY: object checked above
  return (
    ['email', 'name', 'policy', 'classification', 'validFrom', 'validUntil'].every((field) => typeof entry[field] === 'string') &&
    (entry.nationality === null || typeof entry.nationality === 'string') &&
    isStringList(entry.categories)
  );
}

function choicesOf(body: unknown): ClearanceChoices {
  if (typeof body !== 'object' || body === null || !('classifications' in body) || !('categories' in body)) {
    throw new Error('Unexpected clearance choices');
  }
  const { classifications, categories } = body;
  if (!isStringList(classifications) || !isStringList(categories)) {
    throw new Error('Unexpected clearance choices');
  }
  return { classifications, categories };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
