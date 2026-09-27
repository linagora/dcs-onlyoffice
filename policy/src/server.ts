import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { reviewDateFor, serializeOriginatorLabel } from './adatp4774.ts';
import { DEFAULT_DOCUMENT_PARTS, serializeDocumentBinding } from './adatp4778.ts';
import { type ClearanceDirectoryOptions, prepareClearanceDirectory } from './directory/seed.ts';
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
import { computeDocumentLabel, type RollupRule } from './rollup.ts';
import type { SecurityPolicy } from './spif/model.ts';
import { policyNamed } from './spif/lookup.ts';
import { loadPolicies } from './spif/reader.ts';

export interface PolicyServerOptions {
  spifDirectory: string;
  clearanceDirectory?: ClearanceDirectoryOptions;
  markingLanguage?: string;
  reviewPeriodYears?: number;
  rollupRule?: RollupRule;
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
  const rollupRule = options.rollupRule ?? 'clear-parts';
  const app = fastify({ logger: options.logger ?? false });
  const { clearanceDirectory } = options;
  if (clearanceDirectory !== undefined) {
    app.log.info(await prepareClearanceDirectory(clearanceDirectory, policies), 'Clearance directory ready');
    app.addHook('onClose', async () => {
      await clearanceDirectory.store.close();
    });
  }

  const findPolicy = (name: string): SecurityPolicy | null => policyNamed(policies, name);

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

  app.post<{ Params: PolicyParams; Querystring: LanguageQuery }>(
    '/policies/:policy/document-label',
    async (request, reply) => {
      const policy = findPolicy(request.params.policy);
      if (policy === null) {
        return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
      }
      const body = readDocumentLabelRequest(request.body);
      if (body === null) {
        return reply.code(400).send({ error: 'Expected { base, portions: [codes], parts?: [part names] }' });
      }
      const base = labelFromCode(policy, body.base);
      const portions = body.portions.map((code) => labelFromCode(policy, code));
      if (base === null || portions.some((portion) => portion === null)) {
        return reply.code(422).send({ error: 'Every label code must designate a valid label' });
      }
      const result = computeDocumentLabel(
        policy,
        base,
        portions.filter((portion): portion is Label => portion !== null),
        rollupRule,
      );
      if (!result.ok) {
        return reply.code(422).send({ error: result.error });
      }
      const creationDateTime = now();
      const labelXml = serializeOriginatorLabel(policy, result.label, {
        creationDateTime,
        reviewDateTime: reviewDateFor(creationDateTime, reviewPeriodYears),
        originatorEmail: callerEmail(request),
      });
      return {
        label: toView(policy, result.label, request.query.lang ?? defaultLanguage),
        moreRestrictivePortions: result.moreRestrictivePortions,
        rule: rollupRule,
        xml: serializeDocumentBinding(labelXml, body.parts ?? DEFAULT_DOCUMENT_PARTS),
      };
    },
  );

  return app;
}

function labelFromCode(policy: SecurityPolicy, code: string): Label | null {
  const request = parseLabelCode(policy, code);
  const validation = request === null ? null : validateLabel(policy, request);
  return validation !== null && validation.valid ? validation.label : null;
}

interface DocumentLabelRequest {
  base: string;
  portions: string[];
  parts: string[] | null;
}

function readDocumentLabelRequest(body: unknown): DocumentLabelRequest | null {
  if (typeof body !== 'object' || body === null || !('base' in body) || typeof body.base !== 'string') {
    return null;
  }
  const portions: unknown = 'portions' in body ? body.portions : [];
  const parts: unknown = 'parts' in body ? body.parts : null;
  const isStringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
  if (!isStringList(portions) || (parts !== null && !isStringList(parts))) {
    return null;
  }
  return { base: body.base, portions, parts };
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
  const rawCategories = unknownArray('categories' in body ? body.categories : []);
  if (rawCategories === null) {
    return null;
  }
  const categories: LabelRequest['categories'] = [];
  for (const raw of rawCategories) {
    if (typeof raw !== 'object' || raw === null || !('tagSet' in raw) || typeof raw.tagSet !== 'string' || !('values' in raw)) {
      return null;
    }
    const values = unknownArray(raw.values);
    if (values === null || !values.every((value): value is string => typeof value === 'string')) {
      return null;
    }
    categories.push({ tagSet: raw.tagSet, values });
  }
  return { classification: body.classification, categories };
}

// Array.isArray narrows to any[]; its items are unknown until checked.
function unknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
