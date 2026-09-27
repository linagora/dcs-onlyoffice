import { fastify, type FastifyInstance } from 'fastify';
import { accessDecision } from './access.ts';
import { readOriginatorLabel, reviewDateFor, serializeOriginatorLabel } from './adatp4774.ts';
import { DEFAULT_DOCUMENT_PARTS, serializeDocumentBinding } from './adatp4778.ts';
import { callerEmail, callerIsAdministrator } from './caller.ts';
import { registerDirectoryAdministration } from './directory/administration.ts';
import { type ClearanceTerms, type ClearanceTermsRequest, clearanceChoicesOf, readClearanceTerms } from './directory/clearance.ts';
import { currentClearanceOf } from './directory/lookup.ts';
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
import { isStringList, unknownArray } from './guards.ts';
import { deriveOpentdfState, labelAttributes } from './opentdf.ts';
import { computeDocumentLabel, isMoreRestrictive, type RollupRule } from './rollup.ts';
import type { SecurityPolicy } from './spif/model.ts';
import { policyNamed } from './spif/lookup.ts';
import { loadPolicies } from './spif/reader.ts';

export interface PolicyServerOptions {
  spifDirectory: string;
  clearanceDirectory?: ClearanceDirectoryOptions;
  // Shared with the portal, which alone administers the clearance directory.
  directoryAdministrationSecret?: string;
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

type LabelViews = { ok: true; views: LabelView[] } | { ok: false; error: string };

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

  // The label a code designates, under the policy the code names.
  const labelOfCode = (code: string): { policy: SecurityPolicy; label: Label } | null => {
    for (const policy of policies) {
      const label = labelFromCode(policy, code);
      if (label !== null) {
        return { policy, label };
      }
    }
    return null;
  };

  const leastRestrictiveLabel = (): { policy: SecurityPolicy; label: Label } | null => {
    const [policy] = policies;
    const enumeration = policy === undefined ? null : enumerateValidLabels(policy);
    const [label] = enumeration?.ok === true ? enumeration.labels : [];
    return policy === undefined || label === undefined ? null : { policy, label };
  };

  // The views of a policy's valid labels that `keep` keeps.
  const labelViews = (policy: SecurityPolicy, language: string, keep: (label: Label) => boolean): LabelViews => {
    const enumeration = enumerateValidLabels(policy);
    return enumeration.ok ? { ok: true, views: enumeration.labels.filter(keep).map((label) => toView(policy, label, language)) } : enumeration;
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/policies', async () => policies.map((policy) => ({ name: policy.name, oid: policy.oid })));

  // What the provisioning job applies to OpenTDF.
  app.get<{ Params: PolicyParams }>('/policies/:policy/opentdf', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    const derivation = deriveOpentdfState(policy, policies);
    return derivation.ok ? derivation.state : reply.code(422).send({ error: derivation.error });
  });

  app.get<{ Params: PolicyParams; Querystring: LanguageQuery }>('/policies/:policy/labels', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    const views = labelViews(policy, request.query.lang ?? defaultLanguage, () => true);
    return views.ok ? views.views : reply.code(422).send({ error: views.error });
  });

  // The labels the caller's clearance allows, for new portions: an author
  // never writes what they could not read.
  app.get<{ Params: PolicyParams; Querystring: LanguageQuery }>('/policies/:policy/labels/allowed', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    if (clearanceDirectory === undefined) {
      return reply.code(503).send({ error: 'The policy service keeps no clearance directory' });
    }
    const email = callerEmail(request);
    const clearance = email === null ? null : await currentClearanceOf(clearanceDirectory.store, email, policy.name, now());
    const views = labelViews(policy, request.query.lang ?? defaultLanguage, (label) => accessDecision(policy, clearance, label));
    return views.ok ? views.views : reply.code(422).send({ error: views.error });
  });

  // The base labels the caller may give a document. Anyone may raise it;
  // lowering it shows the content in clear to more readers, so only an
  // administrator whose clearance allows the current label may.
  app.get<{ Params: PolicyParams; Querystring: LanguageQuery & { current?: unknown } }>(
    '/policies/:policy/labels/base-choices',
    async (request, reply) => {
      const policy = findPolicy(request.params.policy);
      if (policy === null) {
        return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
      }
      const currentCode: unknown = request.query.current ?? null;
      if (currentCode !== null && typeof currentCode !== 'string') {
        return reply.code(400).send({ error: 'Expected at most one current label' });
      }
      const current = currentCode === null ? null : labelFromCode(policy, currentCode);
      if (currentCode !== null && current === null) {
        return reply.code(422).send({ error: `${currentCode} is not a valid label of ${policy.name}` });
      }
      const email = callerEmail(request);
      const clearance =
        clearanceDirectory === undefined || email === null ? null : await currentClearanceOf(clearanceDirectory.store, email, policy.name, now());
      const keep =
        current === null || (callerIsAdministrator(request) && accessDecision(policy, clearance, current))
          ? (): boolean => true
          : (label: Label): boolean => !isMoreRestrictive(policy, current, label);
      const views = labelViews(policy, request.query.lang ?? defaultLanguage, keep);
      return views.ok ? views.views : reply.code(422).send({ error: views.error });
    },
  );

  // Whether a new base label lowers the previous one: a reader it allows may
  // be refused the previous one.
  app.post('/labels/lowering', async (request, reply) => {
    const fromCode = readTextField(request.body, 'from');
    const toCode = readTextField(request.body, 'to');
    if (fromCode === null || toCode === null) {
      return reply.code(400).send({ error: 'Expected { from, to }' });
    }
    const from = labelOfCode(fromCode);
    const to = labelOfCode(toCode);
    if (from === null || to === null || from.policy !== to.policy) {
      return reply.code(422).send({ error: `${fromCode} and ${toCode} are not two valid labels of one policy` });
    }
    return { lowering: isMoreRestrictive(from.policy, from.label, to.label) };
  });

  // Whether the caller may open documents with these base labels, which cover
  // their content in clear, and the labels decided. A document without a base
  // label counts as the least restrictive label of the first policy, as the
  // panel shows it; an invalid label is refused.
  app.post<{ Querystring: LanguageQuery }>('/labels/decisions', async (request, reply) => {
    const codes = readCodeList(request.body);
    if (codes === null) {
      return reply.code(400).send({ error: 'Expected { codes: [label code or null] }' });
    }
    const email = callerEmail(request);
    const language = request.query.lang ?? defaultLanguage;
    // One reading of the directory per policy.
    const clearances = new Map<string, Promise<ClearanceTerms | null>>();
    const clearanceUnder = (policy: SecurityPolicy): Promise<ClearanceTerms | null> => {
      const known =
        clearances.get(policy.name) ??
        (clearanceDirectory === undefined || email === null
          ? Promise.resolve(null)
          : currentClearanceOf(clearanceDirectory.store, email, policy.name, now()));
      clearances.set(policy.name, known);
      return known;
    };
    const decisions = [];
    for (const code of codes) {
      const decided = code === null ? leastRestrictiveLabel() : labelOfCode(code);
      if (decided === null) {
        decisions.push({ granted: false, label: null });
        continue;
      }
      const clearance = await clearanceUnder(decided.policy);
      decisions.push({ granted: accessDecision(decided.policy, clearance, decided.label), label: toView(decided.policy, decided.label, language) });
    }
    return { decisions };
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

  // The label that an originator label designates, under the policy it names,
  // such as the label bound to an envelope, which the panel compares with the
  // label in clear.
  app.post<{ Querystring: LanguageQuery }>('/labels/parse', async (request, reply) => {
    const xml = readTextField(request.body, 'xml');
    const designated = xml === null ? null : readOriginatorLabel(xml);
    if (designated === null) {
      return reply.code(400).send({ error: 'Expected { xml } holding an ADatP-4774 originator label' });
    }
    const policy = findPolicy(designated.policy);
    if (policy === null || (designated.policyUri !== null && designated.policyUri !== `urn:oid:${policy.oid}`)) {
      return reply.code(422).send({ error: `No policy ${designated.policy} with that identifier` });
    }
    const validation = validateLabel(policy, designated.request);
    if (!validation.valid) {
      return reply.code(422).send({ error: validation.errors.join('; ') });
    }
    return { label: toView(policy, validation.label, request.query.lang ?? defaultLanguage) };
  });

  // The attribute values an envelope carries for a label.
  app.post<{ Params: PolicyParams }>('/policies/:policy/labels/attributes', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    const code = readCode(request.body);
    if (code === null) {
      return reply.code(400).send({ error: 'Expected { code }' });
    }
    const label = labelFromCode(policy, code);
    if (label === null) {
      return reply.code(422).send({ error: `${code} is not a valid label of ${policy.name}` });
    }
    const attributes = labelAttributes(policy, policies, label);
    return attributes.ok ? { attributes: attributes.attributes } : reply.code(422).send({ error: attributes.error });
  });

  // Whether a clearance lets its holder read a label.
  app.post<{ Params: PolicyParams }>('/policies/:policy/access-decision', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    if (policy === null) {
      return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
    }
    const body = readDecisionRequest(request.body);
    if (body === null) {
      return reply.code(400).send({ error: 'Expected { code, clearance: { classification, categories: ["<tag set>:<category>"] } or null }' });
    }
    const label = labelFromCode(policy, body.code);
    if (label === null) {
      return reply.code(422).send({ error: `${body.code} is not a valid label of ${policy.name}` });
    }
    let terms: ClearanceTerms | null = null;
    if (body.clearance !== null) {
      const read = readClearanceTerms(policy, body.clearance);
      if (!read.ok) {
        return reply.code(422).send({ error: read.error });
      }
      terms = read.terms;
    }
    return { granted: accessDecision(policy, terms, label) };
  });

  // What a clearance under the policy can hold, for the administration page.
  app.get<{ Params: PolicyParams }>('/policies/:policy/clearance-choices', async (request, reply) => {
    const policy = findPolicy(request.params.policy);
    return policy === null ? reply.code(404).send({ error: `Unknown policy ${request.params.policy}` }) : clearanceChoicesOf(policy);
  });

  const { directoryAdministrationSecret } = options;
  registerDirectoryAdministration(
    app,
    clearanceDirectory === undefined || directoryAdministrationSecret === undefined ? null : { store: clearanceDirectory.store, secret: directoryAdministrationSecret },
    policies,
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

interface DecisionRequest {
  code: string;
  clearance: ClearanceTermsRequest | null;
}

function readDecisionRequest(body: unknown): DecisionRequest | null {
  const code = readCode(body);
  if (code === null || typeof body !== 'object' || body === null || !('clearance' in body)) {
    return null;
  }
  const { clearance } = body;
  if (clearance === null) {
    return { code, clearance: null };
  }
  if (typeof clearance !== 'object' || !('classification' in clearance) || typeof clearance.classification !== 'string' || !('categories' in clearance)) {
    return null;
  }
  const categories = unknownArray(clearance.categories);
  if (categories === null || !categories.every((category): category is string => typeof category === 'string')) {
    return null;
  }
  return { code, clearance: { classification: clearance.classification, categories } };
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
  if (!isStringList(portions) || (parts !== null && !isStringList(parts))) {
    return null;
  }
  return { base: body.base, portions, parts };
}

function readCode(body: unknown): string | null {
  return readTextField(body, 'code');
}

// A list of label codes, where null stands for a document without a label.
function readCodeList(body: unknown): (string | null)[] | null {
  const codes: unknown = typeof body === 'object' && body !== null && 'codes' in body ? body.codes : null;
  return Array.isArray(codes) && codes.every((code: unknown) => code === null || typeof code === 'string') ? codes : null;
}

function readTextField(body: unknown, name: string): string | null {
  const value: unknown = typeof body === 'object' && body !== null && name in body ? (body as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
  return typeof value === 'string' ? value : null;
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
