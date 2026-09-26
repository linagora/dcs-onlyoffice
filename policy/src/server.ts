import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { reviewDateFor, serializeOriginatorLabel } from './adatp4774.ts';
import {
  enumerateValidLabels,
  type Label,
  type LabelCategory,
  labelCode,
  type LabelRequest,
  parseLabelCode,
  validateLabel,
} from './labels.ts';
import { type Marking, renderMarking } from './marking.ts';
import type { SecurityPolicy } from './spif/model.ts';
import { loadPolicies, sameName } from './spif/reader.ts';

export interface PolicyServerOptions {
  spifDirectory: string;
  markingLanguage?: string;
  reviewPeriodYears?: number;
  now?: () => Date;
  logger?: boolean;
}

export interface LabelView {
  code: string;
  policy: string;
  classification: string;
  categories: LabelCategory[];
  marking: Marking;
}

interface PolicyParams {
  policy: string;
}

interface LanguageQuery {
  lang?: string;
}

export async function buildPolicyServer(options: PolicyServerOptions): Promise<FastifyInstance> {
  const policies = await loadPolicies(options.spifDirectory);
  const defaultLanguage = options.markingLanguage ?? 'en';
  const reviewPeriodYears = options.reviewPeriodYears ?? 5;
  const now = options.now ?? ((): Date => new Date());
  const app = fastify({ logger: options.logger ?? false });

  const findPolicy = (name: string): SecurityPolicy | null =>
    policies.find((policy) => sameName(policy.name, name)) ?? null;

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/policies', async () => policies.map((policy) => ({ name: policy.name, oid: policy.oid })));

  app.get<{ Params: PolicyParams; Querystring: LanguageQuery }>('/policies/:policy/labels', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    const enumeration = enumerateValidLabels(policy);
    if (!enumeration.ok) {
      return reply.code(422).send({ error: enumeration.error });
    }
    const language = request.query.lang ?? defaultLanguage;
    return enumeration.labels.map((label) => toView(policy, label, language));
  });

  app.post<{ Params: PolicyParams; Querystring: LanguageQuery }>(
    '/policies/:policy/labels/validate',
    async (request, reply) => {
      const policy = findPolicy(request.params.policy);
      if (policy === null) {
        return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
      }
      const labelRequest = parseLabelRequest(request.body);
      if (labelRequest === null) {
        return reply.code(400).send({ error: 'Expected { classification, categories: [{ tagSet, values }] }' });
      }
      const validation = validateLabel(policy, labelRequest);
      if (!validation.valid) {
        return validation;
      }
      return { valid: true, label: toView(policy, validation.label, request.query.lang ?? defaultLanguage) };
    },
  );

  app.post<{ Params: PolicyParams; Querystring: LanguageQuery }>(
    '/policies/:policy/labels/adatp4774',
    async (request, reply) => {
      const policy = findPolicy(request.params.policy);
      if (policy === null) {
        return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
      }
      const code = readCode(request.body);
      if (code === null) {
        return reply.code(400).send({ error: 'Expected { code }' });
      }
      const labelRequest = parseLabelCode(policy, code);
      const validation = labelRequest === null ? null : validateLabel(policy, labelRequest);
      if (validation === null || !validation.valid) {
        return reply.code(422).send({ error: `${code} is not a valid label of ${policy.name}` });
      }
      const creationDateTime = now();
      const xml = serializeOriginatorLabel(policy, validation.label, {
        creationDateTime,
        reviewDateTime: reviewDateFor(creationDateTime, reviewPeriodYears),
        originatorEmail: callerEmail(request),
      });
      return { xml, label: toView(policy, validation.label, request.query.lang ?? defaultLanguage) };
    },
  );

  return app;
}

// The portal relay sends the caller's identity URI-encoded.
function callerEmail(request: FastifyRequest): string | null {
  const header = request.headers['x-user-email'];
  const value = typeof header === 'string' ? decodeURIComponent(header) : '';
  return value === '' ? null : value;
}

function readCode(body: unknown): string | null {
  return typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null;
}

function toView(policy: SecurityPolicy, label: Label, language: string): LabelView {
  return {
    code: labelCode(policy, label),
    policy: label.policy,
    classification: label.classification,
    categories: label.categories,
    marking: renderMarking(policy, label, language),
  };
}

function parseLabelRequest(body: unknown): LabelRequest | null {
  if (typeof body !== 'object' || body === null || !('classification' in body) || typeof body.classification !== 'string') {
    return null;
  }
  const rawCategories: unknown = 'categories' in body ? body.categories : [];
  if (!Array.isArray(rawCategories)) {
    return null;
  }
  const categories: LabelRequest['categories'] = [];
  for (const raw of rawCategories) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('tagSet' in raw) ||
      typeof raw.tagSet !== 'string' ||
      !('values' in raw) ||
      !Array.isArray(raw.values) ||
      !raw.values.every((value: unknown) => typeof value === 'string')
    ) {
      return null;
    }
    categories.push({ tagSet: raw.tagSet, values: raw.values });
  }
  return { classification: body.classification, categories };
}
