import { type Label, type LabelCategory, type LabelRequest, validateLabel } from './labels.ts';
import type { CategoryTagSet, SecurityPolicy } from './spif/model.ts';
import { sameName } from './spif/reader.ts';

export type RollupRule = 'clear-parts' | 'high-water-mark';

export const ROLLUP_RULES: readonly RollupRule[] = ['clear-parts', 'high-water-mark'];

export type DocumentLabelResult =
  | { ok: true; label: Label; moreRestrictivePortions: boolean }
  | { ok: false; error: string };

// clear-parts: the document label covers the unprotected content (the base
// label) and gains the SPIF's rollup indicator when a portion is more
// restrictive. high-water-mark: the classic dominant label of every label.
export function computeDocumentLabel(
  policy: SecurityPolicy,
  base: Label,
  portions: Label[],
  rule: RollupRule,
): DocumentLabelResult {
  const moreRestrictivePortions = portions.some((portion) => isMoreRestrictive(policy, portion, base));
  let candidate: Label;
  if (rule === 'high-water-mark') {
    candidate = highWaterMark(policy, [base, ...portions]);
  } else if (moreRestrictivePortions) {
    const withIndicator = addRollupIndicator(policy, base);
    if (withIndicator === null) {
      return { ok: false, error: `${policy.name} declares no rollup indicator for the clear-parts rule` };
    }
    candidate = withIndicator;
  } else {
    candidate = base;
  }
  const validation = validateLabel(policy, toRequest(candidate));
  if (!validation.valid) {
    return { ok: false, error: `The document label is not valid: ${validation.errors.join('; ')}` };
  }
  return { ok: true, label: validation.label, moreRestrictivePortions };
}

// ADatP-4774.1 section 4.4: highest classification by hierarchy, restrictive
// and informative categories united, permissive categories intersected (a tag
// set missing from one label is dropped).
export function highWaterMark(policy: SecurityPolicy, labels: Label[]): Label {
  const classification = labels
    .map((label) => policy.classifications.find((candidate) => sameName(candidate.name, label.classification)))
    .filter((candidate) => candidate !== undefined)
    .reduce((highest, current) => (current.hierarchy > highest.hierarchy ? current : highest));
  const categories: LabelCategory[] = [];
  for (const tagSet of policy.tagSets) {
    const perLabel = labels.map((label) => valuesOf(label, tagSet));
    const selected =
      tagSet.type === 'PERMISSIVE'
        ? perLabel.reduce((common, values) => common.filter((value) => values.includes(value)))
        : [...new Set(perLabel.flat())];
    const ordered = tagSet.categories.map((category) => category.name).filter((name) => selected.includes(name));
    if (ordered.length > 0) {
      categories.push({ tagSet: tagSet.name, type: tagSet.type, values: ordered });
    }
  }
  return { policy: policy.name, classification: classification.name, categories };
}

function addRollupIndicator(policy: SecurityPolicy, label: Label): Label | null {
  const indicator = policy.rollupIndicator;
  if (indicator === null) {
    return null;
  }
  const extra: Label = {
    policy: policy.name,
    classification: label.classification,
    categories: [{ tagSet: indicator.tagSet, type: 'INFORMATIVE', values: [indicator.category] }],
  };
  return highWaterMark(policy, [label, { ...label, categories: [...label.categories, ...extra.categories] }]);
}

// True when a reader allowed by `base` may be refused `portion`, following the
// ADatP-4774 access decision: the classification must be covered, every
// restrictive category held, and one value of each permissive category held.
// Informative categories take no part in it.
export function isMoreRestrictive(policy: SecurityPolicy, portion: Label, base: Label): boolean {
  const hierarchyOf = (label: Label): number =>
    policy.classifications.find((candidate) => sameName(candidate.name, label.classification))?.hierarchy ?? 0;
  if (hierarchyOf(portion) > hierarchyOf(base)) {
    return true;
  }
  return policy.tagSets.some((tagSet) => {
    const portionValues = valuesOf(portion, tagSet);
    const baseValues = valuesOf(base, tagSet);
    switch (tagSet.type) {
      case 'RESTRICTIVE':
        return portionValues.some((value) => !baseValues.includes(value));
      case 'PERMISSIVE':
        return portionValues.length > 0 && (baseValues.length === 0 || baseValues.some((value) => !portionValues.includes(value)));
      default:
        return false;
    }
  });
}

function valuesOf(label: Label, tagSet: CategoryTagSet): string[] {
  return label.categories.find((category) => sameName(category.tagSet, tagSet.name))?.values ?? [];
}

function toRequest(label: Label): LabelRequest {
  return {
    classification: label.classification,
    categories: label.categories.map((category) => ({ tagSet: category.tagSet, values: category.values })),
  };
}
