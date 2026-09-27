import type { AttributeState, OpentdfState, SubjectMappingState } from '../opentdf.ts';
import type { OpentdfPlatform, PlatformAttribute, PlatformSubjectMapping } from './platform.ts';

// What provisioning changed in OpenTDF: all zeros when it already held the state.
export interface ProvisioningChanges {
  namespaces: number;
  attributes: number;
  values: number;
  subjectMappings: number;
  removedSubjectMappings: number;
}

// Subject mappings grant the right to read, which a key request asks for.
const READ = 'read';

// Brings OpenTDF to the state the policy service derived. Envelopes name
// attribute values, so nothing that exists is renamed, reordered or deleted,
// except the subject mappings of the policy's own values that the state no
// longer holds.
export async function applyOpentdfState(platform: OpentdfPlatform, state: OpentdfState): Promise<ProvisioningChanges> {
  let namespaceId = await platform.namespaceId(state.namespace);
  const namespaces = namespaceId === null ? 1 : 0;
  namespaceId ??= await platform.createNamespace(state.namespace);
  const { attributes, values } = await applyAttributes(platform, namespaceId, state);
  const { created, removed } = await applySubjectMappings(platform, state);
  return { namespaces, attributes, values, subjectMappings: created, removedSubjectMappings: removed };
}

async function applyAttributes(platform: OpentdfPlatform, namespaceId: string, state: OpentdfState): Promise<{ attributes: number; values: number }> {
  const counts = { attributes: 0, values: 0 };
  const existing = await platform.attributes(state.namespace);
  for (const wanted of state.attributes) {
    const found = existing.find((attribute) => attribute.name === wanted.name);
    if (found === undefined) {
      await platform.createAttribute(namespaceId, wanted.name, wanted.rule, wanted.values);
      counts.attributes += 1;
      continue;
    }
    for (const value of missingValues(found, wanted)) {
      await platform.createValue(found.id, value);
      counts.values += 1;
    }
  }
  return counts;
}

// The values the attribute lacks, in the state's order. A hierarchy can only
// gain values below the ones it has, and no rule can change.
function missingValues(found: PlatformAttribute, wanted: AttributeState): string[] {
  if (found.rule !== wanted.rule) {
    throw new Error(`attribute ${found.name} has rule ${found.rule ?? 'unknown'} in OpenTDF, not ${wanted.rule}`);
  }
  const present = found.values.map((value) => value.value);
  if (wanted.rule === 'HIERARCHY' && present.some((value, index) => wanted.values[index] !== value)) {
    throw new Error(`the hierarchy ${found.name} is ${present.join(' > ')} in OpenTDF, which ${wanted.values.join(' > ')} cannot extend`);
  }
  return wanted.values.filter((value) => !present.includes(value));
}

// Keeps one mapping that grants each value as the state says, creates the
// missing ones and removes every other mapping of the namespace's values.
async function applySubjectMappings(platform: OpentdfPlatform, state: OpentdfState): Promise<{ created: number; removed: number }> {
  const valueIds = new Map((await platform.attributes(state.namespace)).flatMap((attribute) => attribute.values.map((value) => [value.fqn, value.id])));
  const ownValueIds = new Set(valueIds.values());
  const mappings = (await platform.subjectMappings()).filter((mapping) => ownValueIds.has(mapping.valueId));
  const kept = new Set<string>();
  let created = 0;
  for (const wanted of state.subjectMappings) {
    const valueId = valueIds.get(wanted.valueFqn);
    if (valueId === undefined) {
      throw new Error(`OpenTDF has no attribute value ${wanted.valueFqn}`);
    }
    const match = mappings.find((mapping) => mapping.valueId === valueId && !kept.has(mapping.id) && grants(mapping, wanted));
    if (match === undefined) {
      await platform.createSubjectMapping({ valueId, action: READ, selector: wanted.selector, claimValue: wanted.claimValue });
      created += 1;
    } else {
      kept.add(match.id);
    }
  }
  const stale = mappings.filter((mapping) => !kept.has(mapping.id));
  for (const mapping of stale) {
    await platform.deleteSubjectMapping(mapping.id);
  }
  return { created, removed: stale.length };
}

function grants(mapping: PlatformSubjectMapping, wanted: SubjectMappingState): boolean {
  const { condition } = mapping;
  return (
    condition !== null &&
    condition.selector === wanted.selector &&
    condition.values.length === 1 &&
    condition.values[0] === wanted.claimValue &&
    mapping.actions.length === 1 &&
    mapping.actions[0] === READ
  );
}
