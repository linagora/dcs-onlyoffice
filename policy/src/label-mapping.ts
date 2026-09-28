import { readFile } from 'node:fs/promises';
import { readField, readTextField } from './guards.ts';
import { GUID, type MappedSensitivityLabel, normalizedGuid, type SensitivityLabel } from './sensitivity-label.ts';

// The label mapping of one Microsoft 365 tenant: the sensitivity label of each
// label of the security policy that has one, by label code.
export interface LabelMapping {
  tenant: string;
  labels: Map<string, SensitivityLabel>;
}

// What the security policy makes of a label code of the mapping: its canonical
// code, or what is wrong with it.
export type MappedLabelCode = { ok: true; code: string } | { ok: false; problem: string };

// Reads a label mapping file, `{ tenant, labels: { <label code>: { id, name } } }`.
// A mapping that could write a wrong sensitivity label keeps the service from
// starting.
export async function loadLabelMapping(file: string, canonicalCode: (code: string) => MappedLabelCode): Promise<LabelMapping> {
  const content: unknown = JSON.parse(await readFile(file, 'utf8'));
  const fail = (message: string): never => {
    throw new Error(`Label mapping ${file}: ${message}`);
  };
  const tenant = normalizedGuid(readTextField(content, 'tenant') ?? '');
  if (!GUID.test(tenant)) {
    fail('the tenant id is no GUID');
  }
  const labels = readField(content, 'labels');
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return fail('expected a labels object');
  }
  const entries = new Map<string, SensitivityLabel>();
  for (const [code, entry] of Object.entries(labels)) {
    const canonical = canonicalCode(code);
    if (!canonical.ok) {
      return fail(`${code} ${canonical.problem}`);
    }
    const id = readTextField(entry, 'id') ?? '';
    const name = (readTextField(entry, 'name') ?? '').trim();
    if (!GUID.test(normalizedGuid(id))) {
      fail(`the sensitivity label id of ${code}, ${id}, is no GUID`);
    }
    if (name === '') {
      fail(`the sensitivity label of ${code} has no name`);
    }
    entries.set(canonical.code, { id: normalizedGuid(id), name });
  }
  return { tenant, labels: entries };
}

// The sensitivity label a mapping pairs with a label code.
export function mappedSensitivityLabel(mapping: LabelMapping, code: string): MappedSensitivityLabel {
  return { tenant: mapping.tenant, label: mapping.labels.get(code) ?? null };
}
