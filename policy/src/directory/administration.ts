import type { FastifyInstance } from 'fastify';
import { holdsSecret } from '../bearer.ts';
import { callerEmail } from '../caller.ts';
import { isStringList } from '../guards.ts';
import { policyNamed } from '../spif/lookup.ts';
import type { SecurityPolicy } from '../spif/model.ts';
import { type ClearanceTermsRequest, checkClearance, clearanceView, normalizedEmail } from './clearance.ts';
import type { ClearanceStore } from './store.ts';

// The directory's administration, which only the portal may call: every
// container of the stack can reach the service, but only the portal holds
// the secret. The portal keeps the page to administrators.
export interface DirectoryAdministration {
  store: ClearanceStore;
  secret: string;
}

interface EntryParams {
  policy: string;
  email: string;
}

interface TermsUpdate extends ClearanceTermsRequest {
  validFrom: Date;
  validUntil: Date;
}

export function registerDirectoryAdministration(app: FastifyInstance, administration: DirectoryAdministration | null, policies: SecurityPolicy[]): void {
  app.register(
    async (directory) => {
      directory.addHook('onRequest', async (request, reply) => {
        if (administration === null) {
          return reply.code(503).send({ error: 'The clearance directory is not administered by this service' });
        }
        if (!holdsSecret(request, administration.secret)) {
          return reply.code(403).send({ error: 'The clearance directory is administered through the portal only' });
        }
        return undefined;
      });

      directory.get('/clearances', async () => {
        const views = (await requireAdministration(administration).store.list()).map(clearanceView);
        return { clearances: views.sort((left, right) => left.email.localeCompare(right.email) || left.policy.localeCompare(right.policy)) };
      });

      // Changes the terms and the validity period of an entry, which the SPIF
      // checks as it checks the seed, and answers with the entry before and
      // after the change, which the portal journals. OpenTDF reads the change
      // at the next key request.
      directory.put<{ Params: EntryParams }>('/policies/:policy/clearances/:email', async (request, reply) => {
        const { store } = requireAdministration(administration);
        const policy = policyNamed(policies, request.params.policy);
        if (policy === null) {
          return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
        }
        const terms = readTermsUpdate(request.body);
        if (terms === null) {
          return reply.code(400).send({ error: 'Expected { classification, categories: ["<tag set>:<category>"], validFrom, validUntil }' });
        }
        const noEntry = `The directory holds no clearance of ${request.params.email} under ${policy.name}`;
        const entry = await store.clearanceOf(normalizedEmail(request.params.email), policy.name);
        if (entry === null) {
          return reply.code(404).send({ error: noEntry });
        }
        const check = checkClearance({ email: entry.email, name: entry.name, nationality: entry.nationality, policy: policy.name, ...terms }, policies);
        if (!check.ok) {
          return reply.code(422).send({ error: check.error });
        }
        // An entry removed meanwhile is not created again.
        if (!(await store.update(check.clearance))) {
          return reply.code(404).send({ error: noEntry });
        }
        const change = { before: clearanceView(entry), after: clearanceView(check.clearance) };
        request.log.info({ by: callerEmail(request), ...change }, 'Clearance changed');
        return change;
      });
    },
    { prefix: '/directory' },
  );
}

// The hook has checked it already; the types cannot tell.
function requireAdministration(administration: DirectoryAdministration | null): DirectoryAdministration {
  if (administration === null) {
    throw new Error('The clearance directory is not administered by this service');
  }
  return administration;
}

function readTermsUpdate(body: unknown): TermsUpdate | null {
  if (typeof body !== 'object' || body === null || !('classification' in body) || typeof body.classification !== 'string') {
    return null;
  }
  const categories = 'categories' in body ? body.categories : null;
  const dateOf = (value: unknown): Date | null => {
    const date = typeof value === 'string' ? new Date(value) : null;
    return date === null || Number.isNaN(date.getTime()) ? null : date;
  };
  const validFrom = dateOf('validFrom' in body ? body.validFrom : null);
  const validUntil = dateOf('validUntil' in body ? body.validUntil : null);
  if (!isStringList(categories) || validFrom === null || validUntil === null) {
    return null;
  }
  return { classification: body.classification, categories, validFrom, validUntil };
}
