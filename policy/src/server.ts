import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { accessDecision } from './access.ts';
import { type DesignatedLabel, readOriginatorLabel, reviewDateFor, serializeOriginatorLabel } from './adatp4774.ts';
import { DEFAULT_DOCUMENT_PARTS, serializeDocumentBinding } from './adatp4778.ts';
import type { BindingSigner } from './binding-signature.ts';
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
  policyNameOfCode,
  validateLabel,
} from './labels.ts';
import { loadLabelMapping, mappedSensitivityLabel } from './label-mapping.ts';
import { type Marking, renderMarking } from './marking.ts';
import { isStringList, readTextField, unknownArray } from './guards.ts';
import type { PackageKind } from './opc.ts';
import { deriveOpentdfState, labelAttributes } from './opentdf.ts';
import { acceptPackages, type DocumentLabelOf, registerPackageSignatures } from './package-signing.ts';
import { computeDocumentLabel, type DocumentLabelResult, isMoreRestrictive, type RollupRule } from './rollup.ts';
import type { SecurityPolicy } from './spif/model.ts';
import { policyNamed } from './spif/lookup.ts';
import { PortionLocks, registerPortionLocks } from './portion-locks.ts';
import type { MappedSensitivityLabel } from './sensitivity-label.ts';
import { signatureTrust } from './signature-trust.ts';
import { loadPolicies } from './spif/reader.ts';
import { type ReadLabel, registerUploads } from './uploads.ts';

const DEFAULT_PORTION_LOCK_LEASE_MS = 5 * 60 * 1000;

export interface PolicyServerOptions {
  spifDirectory: string;
  clearanceDirectory?: ClearanceDirectoryOptions;
  // Shared with the portal, which alone administers the clearance directory.
  directoryAdministrationSecret?: string;
  // The key and certificate that sign document label bindings, with the
  // secret the portal holds to ask for signatures; the certificates of the
  // authorities that issue signing certificates, and their revocation lists,
  // as PEM, one after the other. Without authorities, the signing certificate
  // alone is trusted.
  bindingSignature?: { signer: BindingSigner; secret: string; trustAnchors?: string; revocationLists?: string };
  markingLanguage?: string;
  reviewPeriodYears?: number;
  rollupRule?: RollupRule;
  // How long a portion lock lasts unless its holder renews it.
  portionLockLeaseMs?: number;
  // The label mapping of a Microsoft 365 tenant, which gives each stored
  // document its sensitivity label; without it, none is written.
  labelMappingFile?: string;
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

type PolicyLabel = { ok: true; policy: SecurityPolicy; label: Label } | { ok: false; error: string };

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

  // A mapping pairs labels of the security policy without informative
  // categories, which no sensitivity label reflects (ADR 0005).
  const labelMapping =
    options.labelMappingFile === undefined
      ? null
      : await loadLabelMapping(options.labelMappingFile, (code) => {
          const found = labelOfCode(code);
          if (found === null) {
            return { ok: false, problem: 'is no label of the security policy' };
          }
          return found.label.categories.some(isInformative)
            ? { ok: false, problem: 'has an informative category, which sensitivity labels leave out' }
            : { ok: true, code: labelCode(found.policy, found.label) };
        });

  // What the label mapping gives a document label, null without a mapping.
  const sensitivityLabelOf = (code: string | null): MappedSensitivityLabel | null => {
    if (labelMapping === null) {
      return null;
    }
    const found = code === null ? null : labelOfCode(code);
    if (found === null) {
      return { tenant: labelMapping.tenant, label: null };
    }
    return mappedSensitivityLabel(labelMapping, labelCode(found.policy, withoutInformativeCategories(found.label)));
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

  // The ADatP-4774 originator label of a label, created now.
  const originatorLabelXml = (policy: SecurityPolicy, label: Label, originatorEmail: string | null): string => {
    const creationDateTime = now();
    return serializeOriginatorLabel(policy, label, {
      creationDateTime,
      reviewDateTime: reviewDateFor(creationDateTime, reviewPeriodYears),
      originatorEmail,
    });
  };

  // The policy a label names, with that identifier when it gives one; null
  // for another policy, one with the same name among them.
  const namedPolicy = (name: string, uri: string | null): SecurityPolicy | null => {
    const policy = findPolicy(name);
    return policy !== null && (uri === null || uri === `urn:oid:${policy.oid}`) ? policy : null;
  };

  // The valid label an originator label designates, under the policy it names
  // with that identifier.
  const designatedLabel = (designated: DesignatedLabel): PolicyLabel => {
    const policy = namedPolicy(designated.policy, designated.policyUri);
    if (policy === null) {
      return { ok: false, error: `No policy ${designated.policy} with that identifier` };
    }
    const validation = validateLabel(policy, designated.request);
    return validation.valid ? { ok: true, policy, label: validation.label } : { ok: false, error: validation.errors.join('; ') };
  };

  // The document label that a base label and portion labels give under a
  // policy, as the panel computes it; the base label is null when its code
  // designates no valid label.
  const documentLabelUnder = (policy: SecurityPolicy, base: Label | null, portionCodes: readonly string[]): DocumentLabelResult => {
    const portions = portionCodes.map((code) => labelFromCode(policy, code));
    if (base === null || portions.some((portion) => portion === null)) {
      return { ok: false, error: 'Every label code must designate a valid label' };
    }
    return computeDocumentLabel(policy, base, portions.filter((portion): portion is Label => portion !== null), rollupRule);
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  // The caller's valid clearance under a policy, null without one.
  const callerClearance = async (request: FastifyRequest, policy: SecurityPolicy): Promise<ClearanceTerms | null> => {
    const email = callerEmail(request);
    return clearanceDirectory === undefined || email === null ? null : currentClearanceOf(clearanceDirectory.store, email, policy.name, now());
  };

  registerPortionLocks(
    app,
    new PortionLocks(options.portionLockLeaseMs ?? DEFAULT_PORTION_LOCK_LEASE_MS),
    async (request, code) => {
      const decided = labelOfCode(code);
      return decided === null ? null : accessDecision(decided.policy, await callerClearance(request, decided.policy), decided.label);
    },
    now,
  );

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

  // The labels the caller may put instead of `current`: raising it only,
  // since lowering it shows what it covers to more readers, unless the caller
  // is an administrator whose clearance allows it.
  // With `readableOnly`, only the labels the caller's clearance allows.
  const replacingLabels = async (
    request: FastifyRequest,
    policy: SecurityPolicy,
    language: string,
    current: Label | null,
    readableOnly: boolean,
  ): Promise<LabelViews> => {
    const clearance = await callerClearance(request, policy);
    const mayLower = current === null || (callerIsAdministrator(request) && accessDecision(policy, clearance, current));
    const lowers = (label: Label): boolean => current !== null && isMoreRestrictive(policy, current, label);
    return labelViews(policy, language, (label) => (mayLower || !lowers(label)) && (!readableOnly || accessDecision(policy, clearance, label)));
  };

  // The base labels the caller may give a document: any label.
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
      const views = await replacingLabels(request, policy, request.query.lang ?? defaultLanguage, current, false);
      return views.ok ? views.views : reply.code(422).send({ error: views.error });
    },
  );

  // The labels the caller may give a portion instead of its current one:
  // those their clearance allows, as for a new portion, since an author never
  // writes what they could not read.
  app.get<{ Params: PolicyParams; Querystring: LanguageQuery & { current?: unknown } }>(
    '/policies/:policy/labels/portion-choices',
    async (request, reply) => {
      const policy = findPolicy(request.params.policy);
      if (policy === null) {
        return reply.code(404).send({ error: `Unknown policy ${request.params.policy}` });
      }
      const currentCode: unknown = request.query.current ?? null;
      if (typeof currentCode !== 'string') {
        return reply.code(400).send({ error: 'Expected the current label' });
      }
      const current = labelFromCode(policy, currentCode);
      if (current === null) {
        return reply.code(422).send({ error: `${currentCode} is not a valid label of ${policy.name}` });
      }
      const views = await replacingLabels(request, policy, request.query.lang ?? defaultLanguage, current, true);
      return views.ok ? views.views : reply.code(422).send({ error: views.error });
    },
  );

  // Whether a new label, of a document's base label or of a portion, lowers
  // the previous one: a reader it allows may be refused the previous one.
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
      const xml = originatorLabelXml(policy, validation.label, callerEmail(request));
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
    const found = designatedLabel(designated);
    if (!found.ok) {
      return reply.code(422).send({ error: found.error });
    }
    return { label: toView(found.policy, found.label, request.query.lang ?? defaultLanguage) };
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

  // The code of the label an ADatP-4774 originator label element designates,
  // or why it designates none: it names another policy, or no valid label of
  // the policy it names.
  const labelOfXml = (xml: string): ReadLabel => {
    const designated = readOriginatorLabel(xml);
    if (designated !== null && namedPolicy(designated.policy, designated.policyUri) === null) {
      return { ok: false, refusal: 'foreign-label' };
    }
    const found = designated === null ? null : designatedLabel(designated);
    return found?.ok === true ? { ok: true, code: labelCode(found.policy, found.label) } : { ok: false, refusal: 'invalid-label' };
  };

  const { bindingSignature } = options;
  if (bindingSignature !== undefined) {
    // A document without a base label counts as the least restrictive label
    // of the first policy, as the panel shows it. The signed label names no
    // originator: the policy service computed it.
    const documentLabelOf: DocumentLabelOf = (baseCode, portionCodes) => {
      const base = baseCode === null ? leastRestrictiveLabel() : labelOfCode(baseCode);
      if (base === null) {
        return { ok: false, error: 'The base label designates no valid label' };
      }
      const result = documentLabelUnder(base.policy, base.label, portionCodes);
      return result.ok ? { ok: true, code: labelCode(base.policy, result.label), labelXml: originatorLabelXml(base.policy, result.label, null) } : result;
    };
    const trust = signatureTrust(bindingSignature.signer.certificate, bindingSignature.trustAnchors ?? '', bindingSignature.revocationLists ?? '', now());
    acceptPackages(app);
    registerPackageSignatures(app, {
      secret: bindingSignature.secret,
      signer: bindingSignature.signer,
      trust,
      now,
      sensitivityLabelOf,
      codeOfLabelXml: (xml) => {
        const read = labelOfXml(xml);
        return read.ok ? read.code : null;
      },
      documentLabelOf,
    });
    // Uploads share the portal's secret, and end signed as a save.
    registerUploads(app, {
      secret: bindingSignature.secret,
      trust,
      documentLabelOf,
      readLabelCode: (code) => {
        const found = labelOfCode(code);
        if (found !== null) {
          return { ok: true, code: labelCode(found.policy, found.label) };
        }
        return { ok: false, refusal: namedPolicy(policyNameOfCode(code) ?? '', null) === null ? 'foreign-label' : 'invalid-label' };
      },
      readLabelXml: labelOfXml,
      baseLabelOf: (code) => {
        const found = labelOfCode(code);
        return found === null ? code : labelCode(found.policy, withoutInformativeCategories(found.label));
      },
      labelMapping,
      now,
    });
  }

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
        return reply.code(400).send({ error: 'Expected { base, portions: [codes], parts?: [part names], packageKind?: "text-document" | "workbook" }' });
      }
      const result = documentLabelUnder(policy, labelFromCode(policy, body.base), body.portions);
      if (!result.ok) {
        return reply.code(422).send({ error: result.error });
      }
      const labelXml = originatorLabelXml(policy, result.label, callerEmail(request));
      return {
        label: toView(policy, result.label, request.query.lang ?? defaultLanguage),
        moreRestrictivePortions: result.moreRestrictivePortions,
        rule: rollupRule,
        xml: serializeDocumentBinding(labelXml, body.parts ?? DEFAULT_DOCUMENT_PARTS[body.packageKind]),
      };
    },
  );

  return app;
}

// A label without its informative categories, which a base label and a
// sensitivity label leave to the document label.
function withoutInformativeCategories(label: Label): Label {
  return { ...label, categories: label.categories.filter((category) => !isInformative(category)) };
}

// An informative category restricts nothing: no access rule reads it.
function isInformative(category: LabelCategory): boolean {
  return category.type === 'INFORMATIVE';
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
  // The format whose parts the binding references when the request names
  // none: a text document's unless told otherwise.
  packageKind: PackageKind;
}

function readDocumentLabelRequest(body: unknown): DocumentLabelRequest | null {
  if (typeof body !== 'object' || body === null || !('base' in body) || typeof body.base !== 'string') {
    return null;
  }
  const portions: unknown = 'portions' in body ? body.portions : [];
  const parts: unknown = 'parts' in body ? body.parts : null;
  const packageKind: unknown = 'packageKind' in body ? body.packageKind : 'text-document';
  if (!isStringList(portions) || (parts !== null && !isStringList(parts)) || (packageKind !== 'text-document' && packageKind !== 'workbook')) {
    return null;
  }
  return { base: body.base, portions, parts, packageKind };
}

function readCode(body: unknown): string | null {
  return readTextField(body, 'code');
}

// A list of label codes, where null stands for a document without a label.
function readCodeList(body: unknown): (string | null)[] | null {
  const codes: unknown = typeof body === 'object' && body !== null && 'codes' in body ? body.codes : null;
  return Array.isArray(codes) && codes.every((code: unknown) => code === null || typeof code === 'string') ? codes : null;
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
