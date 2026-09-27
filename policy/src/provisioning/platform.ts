import type { AttributeRule } from '../opentdf.ts';
import { field, fetchJson, list, text } from './json.ts';

// What the provisioning job reads of OpenTDF's policy objects.
export interface PlatformValue {
  id: string;
  value: string;
  fqn: string;
}

export interface PlatformAttribute {
  id: string;
  name: string;
  rule: AttributeRule | null;
  values: PlatformValue[];
}

// The claim read with the selector holds one of the values.
export interface PlatformCondition {
  selector: string;
  values: string[];
}

export interface PlatformSubjectMapping {
  id: string;
  valueId: string;
  // Null when the condition set is anything else than a single condition.
  condition: PlatformCondition | null;
  actions: string[];
}

export interface NewSubjectMapping {
  valueId: string;
  action: string;
  selector: string;
  claimValue: string;
}

export interface PlatformKasKey {
  keyId: string;
  // The registry's name of the algorithm, such as ALGORITHM_HPQT_SECP384R1_MLKEM1024.
  algorithm: string;
  // The private key, wrapped with the KAS's root key.
  wrappedPrivateKey: string | null;
}

export interface NewKasKey {
  kasId: string;
  keyId: string;
  algorithm: string;
  publicPem: string;
  wrappedPrivateKey: string;
}

// The key new envelopes wrap their key for, and the KAS that holds it.
export interface PlatformBaseKey {
  kasUri: string;
  keyId: string;
}

const RULE_PREFIX = 'ATTRIBUTE_RULE_TYPE_ENUM_';
// The KAS unwraps with the root key of its configuration, whatever this id.
const ROOT_KEY_ID = 'root';
const IN_OPERATOR = 'SUBJECT_MAPPING_OPERATOR_ENUM_IN';

// OpenTDF's policy API, called as Connect unary calls in JSON with the
// provisioning identity's token.
export class OpentdfPlatform {
  #url: string;
  #token: string;

  constructor(url: string, token: string) {
    this.#url = url;
    this.#token = token;
  }

  async namespaceId(name: string): Promise<string | null> {
    const namespaces = await this.#listAll('policy.namespaces.NamespaceService/ListNamespaces', {}, 'namespaces');
    const found = namespaces.find((namespace) => text(field(namespace, 'name')) === name);
    return found === undefined ? null : requiredText(found, 'id');
  }

  async createNamespace(name: string): Promise<string> {
    const answer = await this.#call('policy.namespaces.NamespaceService/CreateNamespace', { name });
    return requiredText(field(answer, 'namespace'), 'id');
  }

  async attributes(namespace: string): Promise<PlatformAttribute[]> {
    const attributes = await this.#listAll('policy.attributes.AttributesService/ListAttributes', { namespace }, 'attributes');
    return attributes.map((attribute) => ({
      id: requiredText(attribute, 'id'),
      name: requiredText(attribute, 'name'),
      rule: ruleOf(field(attribute, 'rule')),
      values: list(field(attribute, 'values')).map((value) => ({
        id: requiredText(value, 'id'),
        value: requiredText(value, 'value'),
        fqn: requiredText(value, 'fqn'),
      })),
    }));
  }

  async createAttribute(namespaceId: string, name: string, rule: AttributeRule, values: string[]): Promise<void> {
    await this.#call('policy.attributes.AttributesService/CreateAttribute', { namespaceId, name, rule: `${RULE_PREFIX}${rule}`, values });
  }

  async createValue(attributeId: string, value: string): Promise<void> {
    await this.#call('policy.attributes.AttributesService/CreateAttributeValue', { attributeId, value });
  }

  async subjectMappings(): Promise<PlatformSubjectMapping[]> {
    const mappings = await this.#listAll('policy.subjectmapping.SubjectMappingService/ListSubjectMappings', {}, 'subjectMappings');
    return mappings.map((mapping) => ({
      id: requiredText(mapping, 'id'),
      valueId: requiredText(field(mapping, 'attributeValue'), 'id'),
      condition: singleCondition(field(mapping, 'subjectConditionSet')),
      actions: list(field(mapping, 'actions')).map((action) => text(field(action, 'name')) ?? ''),
    }));
  }

  // A condition set of one condition: the claim read with the selector holds
  // the claim value.
  async createSubjectMapping(mapping: NewSubjectMapping): Promise<void> {
    const condition = { subjectExternalSelectorValue: mapping.selector, operator: IN_OPERATOR, subjectExternalValues: [mapping.claimValue] };
    await this.#call('policy.subjectmapping.SubjectMappingService/CreateSubjectMapping', {
      attributeValueId: mapping.valueId,
      actions: [{ name: mapping.action }],
      newSubjectConditionSet: {
        subjectSets: [{ conditionGroups: [{ booleanOperator: 'CONDITION_BOOLEAN_TYPE_ENUM_AND', conditions: [condition] }] }],
      },
    });
  }

  async deleteSubjectMapping(id: string): Promise<void> {
    await this.#call('policy.subjectmapping.SubjectMappingService/DeleteSubjectMapping', { id });
  }

  // The id the key registry gives the KAS at this address, if it holds it.
  async kasId(uri: string): Promise<string | null> {
    const servers = await this.#listAll('policy.kasregistry.KeyAccessServerRegistryService/ListKeyAccessServers', {}, 'keyAccessServers');
    const found = servers.find((server) => text(field(server, 'uri')) === uri);
    return found === undefined ? null : requiredText(found, 'id');
  }

  async registerKas(uri: string): Promise<string> {
    const answer = await this.#call('policy.kasregistry.KeyAccessServerRegistryService/CreateKeyAccessServer', { uri });
    return requiredText(field(answer, 'keyAccessServer'), 'id');
  }

  async kasKey(kasId: string, keyId: string): Promise<PlatformKasKey | null> {
    const kasKeys = await this.#listAll('policy.kasregistry.KeyAccessServerRegistryService/ListKeys', { kasId }, 'kasKeys');
    const found = kasKeys.map((kasKey) => field(kasKey, 'key')).find((key) => text(field(key, 'keyId')) === keyId);
    return found === undefined
      ? null
      : { keyId, algorithm: requiredText(found, 'keyAlgorithm'), wrappedPrivateKey: text(field(field(found, 'privateKeyCtx'), 'wrappedKey')) };
  }

  // A key whose private half the KAS unwraps with its root key.
  async createRootKeyWrappedKey(key: NewKasKey): Promise<void> {
    await this.#call('policy.kasregistry.KeyAccessServerRegistryService/CreateKey', {
      kasId: key.kasId,
      keyId: key.keyId,
      keyAlgorithm: key.algorithm,
      keyMode: 'KEY_MODE_CONFIG_ROOT_KEY',
      publicKeyCtx: { pem: Buffer.from(key.publicPem).toString('base64') },
      privateKeyCtx: { keyId: ROOT_KEY_ID, wrappedKey: key.wrappedPrivateKey },
    });
  }

  async baseKey(): Promise<PlatformBaseKey | null> {
    const answer = await this.#call('policy.kasregistry.KeyAccessServerRegistryService/GetBaseKey', {});
    const baseKey = field(answer, 'baseKey');
    const kasUri = text(field(baseKey, 'kasUri'));
    const keyId = text(field(field(baseKey, 'publicKey'), 'kid'));
    return kasUri === null || keyId === null ? null : { kasUri, keyId };
  }

  async setBaseKey(kasId: string, keyId: string): Promise<void> {
    await this.#call('policy.kasregistry.KeyAccessServerRegistryService/SetBaseKey', { key: { kasId, kid: keyId } });
  }

  // Follows the pages of a list call.
  async #listAll(method: string, request: Record<string, unknown>, listName: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let offset = 0;
    do {
      const answer = await this.#call(method, { ...request, pagination: { offset } });
      items.push(...list(field(answer, listName)));
      const next = field(field(answer, 'pagination'), 'nextOffset');
      offset = typeof next === 'number' ? next : 0;
    } while (offset > 0);
    return items;
  }

  async #call(method: string, body: unknown): Promise<unknown> {
    const answer = await fetchJson(`${this.#url}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify(body),
    });
    if (answer.status !== 200) {
      throw new Error(`${method} answered ${answer.status}: ${text(field(answer.body, 'message')) ?? JSON.stringify(answer.body)}`);
    }
    return answer.body;
  }
}

function ruleOf(value: unknown): AttributeRule | null {
  switch (value) {
    case `${RULE_PREFIX}HIERARCHY`:
      return 'HIERARCHY';
    case `${RULE_PREFIX}ALL_OF`:
      return 'ALL_OF';
    case `${RULE_PREFIX}ANY_OF`:
      return 'ANY_OF';
    default:
      return null;
  }
}

function singleCondition(conditionSet: unknown): PlatformCondition | null {
  const sets = list(field(conditionSet, 'subjectSets'));
  const groups = sets.length === 1 ? list(field(sets[0], 'conditionGroups')) : [];
  const conditions = groups.length === 1 ? list(field(groups[0], 'conditions')) : [];
  const condition = conditions.length === 1 ? conditions[0] : null;
  if (condition === null || field(condition, 'operator') !== IN_OPERATOR) {
    return null;
  }
  return {
    selector: text(field(condition, 'subjectExternalSelectorValue')) ?? '',
    values: list(field(condition, 'subjectExternalValues')).map((value) => text(value) ?? ''),
  };
}

function requiredText(value: unknown, name: string): string {
  const found = text(field(value, name));
  if (found === null) {
    throw new Error(`OpenTDF answered without ${name}`);
  }
  return found;
}
