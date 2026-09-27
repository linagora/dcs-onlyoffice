import type { AttributeRule, AttributeState, OpentdfDerivation, OpentdfState, SubjectMappingState } from '../opentdf.ts';
import { field, fetchJson, list, text, texts } from './json.ts';

const RULES: readonly string[] = ['HIERARCHY', 'ALL_OF', 'ANY_OF'] satisfies AttributeRule[];

// The names of the policies the service holds.
export async function policyNames(policyUrl: string): Promise<string[]> {
  const answer = await fetchJson(`${policyUrl}/policies`);
  const names = answer.status === 200 && Array.isArray(answer.body) ? answer.body.map((policy: unknown) => text(field(policy, 'name'))) : null;
  if (names === null || names.some((name) => name === null)) {
    throw new Error(`the policy service answered ${answer.status} with no policy list`);
  }
  return names.filter((name): name is string => name !== null);
}

// What OpenTDF must hold for a policy, or why the service cannot provision it.
export async function opentdfStateOf(policyUrl: string, policy: string): Promise<OpentdfDerivation> {
  const answer = await fetchJson(`${policyUrl}/policies/${encodeURIComponent(policy)}/opentdf`);
  if (answer.status === 422) {
    return { ok: false, error: text(field(answer.body, 'error')) ?? 'no reason given' };
  }
  const state = answer.status === 200 ? readState(answer.body) : null;
  if (state === null) {
    throw new Error(`the policy service answered ${answer.status} with no OpenTDF state for ${policy}`);
  }
  return { ok: true, state };
}

function readState(body: unknown): OpentdfState | null {
  const namespace = text(field(body, 'namespace'));
  const attributes = list(field(body, 'attributes')).map(readAttribute);
  const subjectMappings = list(field(body, 'subjectMappings')).map(readSubjectMapping);
  if (namespace === null || attributes.some((attribute) => attribute === null) || subjectMappings.some((mapping) => mapping === null)) {
    return null;
  }
  return {
    namespace,
    attributes: attributes.filter((attribute): attribute is AttributeState => attribute !== null),
    subjectMappings: subjectMappings.filter((mapping): mapping is SubjectMappingState => mapping !== null),
  };
}

function readAttribute(value: unknown): AttributeState | null {
  const name = text(field(value, 'name'));
  const rule = field(value, 'rule');
  const values = texts(field(value, 'values'));
  return name === null || !isRule(rule) || values === null ? null : { name, rule, values };
}

function readSubjectMapping(value: unknown): SubjectMappingState | null {
  const valueFqn = text(field(value, 'valueFqn'));
  const selector = text(field(value, 'selector'));
  const claimValue = text(field(value, 'claimValue'));
  return valueFqn === null || selector === null || claimValue === null ? null : { valueFqn, selector, claimValue };
}

function isRule(value: unknown): value is AttributeRule {
  return typeof value === 'string' && RULES.includes(value);
}
