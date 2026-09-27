import { CATEGORIES_CLAIM, CLASSIFICATIONS_CLAIM, categoryClaim, classificationClaim } from './directory/clearance.ts';
import type { Label } from './labels.ts';
import type { SecurityPolicy } from './spif/model.ts';

// OpenTDF's attribute rules, as ADR 0003 maps the SPIF onto them.
export type AttributeRule = 'HIERARCHY' | 'ALL_OF' | 'ANY_OF';

export interface AttributeState {
  name: string;
  rule: AttributeRule;
  // A hierarchy lists its values from the highest.
  values: string[];
}

// Grants an attribute value to the people whose claim, read with the
// selector, holds the claim value.
export interface SubjectMappingState {
  valueFqn: string;
  selector: string;
  claimValue: string;
}

// What OpenTDF must hold for its decisions to be the policy's access decisions.
export interface OpentdfState {
  namespace: string;
  attributes: AttributeState[];
  subjectMappings: SubjectMappingState[];
}

export type OpentdfDerivation = { ok: true; state: OpentdfState } | { ok: false; error: string };

export type LabelAttributes = { ok: true; attributes: string[] } | { ok: false; error: string };

const CLASSIFICATION_ATTRIBUTE = 'classification';

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// One OpenTDF value and the SPIF name it comes from.
interface DerivedValue {
  spifName: string;
  name: string;
  claimValue: string;
}

interface DerivedAttribute {
  name: string;
  rule: AttributeRule;
  // The SPIF tag set, or null for the classification.
  tagSet: string | null;
  selector: string;
  values: DerivedValue[];
}

type Derivation = { ok: true; namespace: string; attributes: DerivedAttribute[] } | { ok: false; error: string };

// Every policy of the service is needed: they cannot share a namespace.
export function deriveOpentdfState(policy: SecurityPolicy, policies: SecurityPolicy[]): OpentdfDerivation {
  const derivation = derive(policy, policies);
  if (!derivation.ok) {
    return derivation;
  }
  const { namespace, attributes } = derivation;
  return {
    ok: true,
    state: {
      namespace,
      attributes: attributes.map(({ name, rule, values }) => ({ name, rule, values: values.map((value) => value.name) })),
      subjectMappings: attributes.flatMap((attribute) =>
        attribute.values.map((value) => ({
          valueFqn: valueFqn(namespace, attribute.name, value.name),
          selector: attribute.selector,
          claimValue: value.claimValue,
        })),
      ),
    },
  };
}

// The FQNs of the attribute values an envelope carries for a valid label:
// informative categories have none.
// A valid label spells its names as the SPIF does.
export function labelAttributes(policy: SecurityPolicy, policies: SecurityPolicy[], label: Label): LabelAttributes {
  const derivation = derive(policy, policies);
  if (!derivation.ok) {
    return derivation;
  }
  const { namespace, attributes } = derivation;
  const fqnsOf = (tagSet: string | null, spifNames: string[]): string[] => {
    const attribute = attributes.find((candidate) => candidate.tagSet === tagSet);
    if (attribute === undefined) {
      return [];
    }
    return attribute.values.filter((value) => spifNames.includes(value.spifName)).map((value) => valueFqn(namespace, attribute.name, value.name));
  };
  return {
    ok: true,
    attributes: [
      ...fqnsOf(null, [label.classification]),
      ...label.categories.flatMap((category) => fqnsOf(category.tagSet, category.values)),
    ],
  };
}

// The attributes of a policy, or why OpenTDF cannot hold them.
function derive(policy: SecurityPolicy, policies: SecurityPolicy[]): Derivation {
  const problem = (reason: string): Derivation => ({ ok: false, error: `${policy.name} cannot be provisioned in OpenTDF: ${reason}` });
  const namespace = policy.attributeNamespace;
  if (namespace === null) {
    return problem('its SPIF declares no attribute namespace');
  }
  if (!HOST_NAME.test(namespace)) {
    return problem(`its attribute namespace "${namespace}" is not a host name`);
  }
  // Two policies in one namespace would share attributes.
  const sharing = policies.find((other) => other !== policy && other.attributeNamespace === namespace);
  if (sharing !== undefined) {
    return problem(`policy ${sharing.name} declares the same attribute namespace`);
  }
  const classifications = [...policy.classifications].sort((left, right) => right.hierarchy - left.hierarchy);
  const tied = classifications.findIndex((classification, index) => classifications[index + 1]?.hierarchy === classification.hierarchy);
  if (tied !== -1) {
    // An OpenTDF hierarchy would put one above the other.
    return problem(`${classifications[tied]?.name} and ${classifications[tied + 1]?.name} share a hierarchy level`);
  }
  const attributes: DerivedAttribute[] = [
    {
      name: CLASSIFICATION_ATTRIBUTE,
      rule: 'HIERARCHY',
      tagSet: null,
      selector: `.${CLASSIFICATIONS_CLAIM}[]`,
      values: classifications.map((classification) => ({
        spifName: classification.name,
        name: openTdfName(classification.name),
        claimValue: classificationClaim(policy.name, classification.name),
      })),
    },
  ];
  for (const tagSet of policy.tagSets) {
    if (tagSet.type === 'INFORMATIVE') {
      continue;
    }
    attributes.push({
      name: openTdfName(tagSet.name),
      rule: tagSet.type === 'RESTRICTIVE' ? 'ALL_OF' : 'ANY_OF',
      tagSet: tagSet.name,
      selector: `.${CATEGORIES_CLAIM}[]`,
      values: tagSet.categories.map((category) => ({
        spifName: category.name,
        name: openTdfName(category.name),
        claimValue: categoryClaim(policy.name, { tagSet: tagSet.name, name: category.name }),
      })),
    });
  }
  const naming = namingProblem([
    attributes.map((attribute) => ({ spifName: attribute.tagSet ?? 'the classification', name: attribute.name })),
    ...attributes.map((attribute) => attribute.values),
  ]);
  return naming === null ? { ok: true, namespace, attributes } : problem(naming);
}

// Within each group, names must stay distinct once written for OpenTDF.
function namingProblem(groups: { spifName: string; name: string }[][]): string | null {
  for (const group of groups) {
    const writers = new Map<string, string>();
    for (const { spifName, name } of group) {
      if (name === '') {
        return `${spifName} has no letter or digit to write`;
      }
      const earlier = writers.get(name);
      if (earlier !== undefined) {
        return `${earlier} and ${spifName} are both written ${name}`;
      }
      writers.set(name, spifName);
    }
  }
  return null;
}

// OpenTDF names hold letters, digits and hyphens: a SPIF name is written in
// lower case, without accents, with hyphens between its words.
function openTdfName(spifName: string): string {
  return spifName
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function valueFqn(namespace: string, attribute: string, value: string): string {
  return `https://${namespace}/attr/${attribute}/value/${value}`;
}
