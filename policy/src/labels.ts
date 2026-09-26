import type {
  CategoryGroup,
  CategoryTagSet,
  CategoryType,
  RequiredCategoryRule,
  SecurityClassification,
  SecurityPolicy,
  TagCategory,
} from './spif/model.ts';
import { sameName } from './spif/reader.ts';

export interface LabelCategory {
  tagSet: string;
  type: CategoryType;
  values: string[];
}

export interface Label {
  policy: string;
  classification: string;
  categories: LabelCategory[];
}

export interface LabelRequest {
  classification: string;
  categories: { tagSet: string; values: string[] }[];
}

export type LabelValidation = { valid: true; label: Label } | { valid: false; errors: string[] };

export type LabelEnumeration = { ok: true; labels: Label[] } | { ok: false; error: string };

interface SelectedCategory {
  tagSet: CategoryTagSet;
  category: TagCategory;
}

// Listing every valid label means trying every combination of categories;
// beyond this many categories the list would be too long to be useful.
const MAX_ENUMERATED_CATEGORIES = 12;

export function validateLabel(policy: SecurityPolicy, request: LabelRequest): LabelValidation {
  const errors: string[] = [];
  const classification = policy.classifications.find((candidate) => sameName(candidate.name, request.classification)) ?? null;
  if (classification === null) {
    errors.push(`Unknown classification ${request.classification}`);
  }
  const selected: SelectedCategory[] = [];
  for (const requested of request.categories) {
    const tagSet = policy.tagSets.find((candidate) => sameName(candidate.name, requested.tagSet)) ?? null;
    if (tagSet === null) {
      errors.push(`Unknown tag set ${requested.tagSet}`);
      continue;
    }
    for (const value of requested.values) {
      const category = tagSet.categories.find((candidate) => sameName(candidate.name, value)) ?? null;
      if (category === null) {
        errors.push(`Unknown category ${value} in ${tagSet.name}`);
      } else if (!selected.some((existing) => existing.category === category)) {
        selected.push({ tagSet, category });
      }
    }
  }
  if (classification === null || errors.length > 0) {
    return { valid: false, errors };
  }
  const violations = ruleViolations(policy, classification, selected);
  if (violations.length > 0) {
    return { valid: false, errors: violations };
  }
  return { valid: true, label: buildLabel(policy, classification, selected) };
}

// Labels are ordered by classification hierarchy, then by number of
// categories, then by the order of the categories in the SPIF.
export function enumerateValidLabels(policy: SecurityPolicy): LabelEnumeration {
  const candidates: SelectedCategory[] = policy.tagSets.flatMap((tagSet) =>
    tagSet.categories
      .filter((category) => !category.obsolete && !isRollupIndicator(policy, tagSet, category))
      .map((category) => ({ tagSet, category })),
  );
  if (candidates.length > MAX_ENUMERATED_CATEGORIES) {
    return { ok: false, error: `${policy.name} has too many categories to list every label` };
  }
  const classifications = policy.classifications
    .filter((classification) => !classification.obsolete)
    .sort((left, right) => left.hierarchy - right.hierarchy);
  const labels: Label[] = [];
  for (const classification of classifications) {
    for (let size = 0; size <= candidates.length; size += 1) {
      for (const indices of combinations(candidates.length, size)) {
        const selected = indices.map((index) => candidates[index]).filter((candidate) => candidate !== undefined);
        if (ruleViolations(policy, classification, selected).length === 0) {
          labels.push(buildLabel(policy, classification, selected));
        }
      }
    }
  }
  return { ok: true, labels };
}

// A short code for content-control tags: policy, classification lacv, then for
// each tag set the last arc of its OID and the selected category lacvs, e.g.
// "DEMO-FR:2/1.1".
export function labelCode(policy: SecurityPolicy, label: Label): string {
  const classification = findClassification(policy, label.classification);
  const segments = label.categories.map((labelCategory) => {
    const tagSet = findTagSet(policy, labelCategory.tagSet);
    const lacvs = labelCategory.values.map((value) => findCategory(tagSet, value).lacv);
    return `/${tagSet.codeArc}.${lacvs.join('+')}`;
  });
  return `${policy.name}:${classification.lacv}${segments.join('')}`;
}

// Reverse of labelCode. Returns null when the code does not designate existing
// entries of this policy; the result still has to be validated.
export function parseLabelCode(policy: SecurityPolicy, code: string): LabelRequest | null {
  const match = /^([^:]+):(\d+)((?:\/[^/.]+\.\d+(?:\+\d+)*)*)$/.exec(code);
  if (match === null || match[1] === undefined || match[2] === undefined || !sameName(match[1], policy.name)) {
    return null;
  }
  const classification = policy.classifications.find((candidate) => candidate.lacv === Number(match[2]));
  if (classification === undefined) {
    return null;
  }
  const categories: LabelRequest['categories'] = [];
  for (const segment of (match[3] ?? '').split('/').filter((part) => part !== '')) {
    const [arc, lacvList] = segment.split('.');
    const tagSet = policy.tagSets.find((candidate) => candidate.codeArc === arc);
    if (tagSet === undefined || lacvList === undefined) {
      return null;
    }
    const values: string[] = [];
    for (const lacv of lacvList.split('+')) {
      const category = tagSet.categories.find((candidate) => candidate.lacv === Number(lacv));
      if (category === undefined) {
        return null;
      }
      values.push(category.name);
    }
    categories.push({ tagSet: tagSet.name, values });
  }
  return { classification: classification.name, categories };
}

function isRollupIndicator(policy: SecurityPolicy, tagSet: CategoryTagSet, category: TagCategory): boolean {
  const indicator = policy.rollupIndicator;
  return indicator !== null && sameName(indicator.tagSet, tagSet.name) && sameName(indicator.category, category.name);
}

function ruleViolations(
  policy: SecurityPolicy,
  classification: SecurityClassification,
  selected: SelectedCategory[],
): string[] {
  const violations: string[] = [];
  if (classification.obsolete) {
    violations.push(`${classification.name} is obsolete`);
  }
  for (const tagSet of policy.tagSets) {
    const count = selected.filter((entry) => entry.tagSet === tagSet).length;
    if (tagSet.singleSelection && count > 1) {
      violations.push(`${tagSet.name} allows a single value`);
    }
    if (tagSet.maxSelection !== null && count > tagSet.maxSelection) {
      violations.push(`${tagSet.name} allows at most ${tagSet.maxSelection} values`);
    }
  }
  for (const rule of classification.requiredCategories) {
    if (!isSatisfied(rule, selected, null)) {
      violations.push(`${classification.name} requires ${describeRule(rule)}`);
    }
  }
  for (const entry of selected) {
    const { category } = entry;
    if (category.obsolete) {
      violations.push(`${category.name} is obsolete`);
    }
    if (category.excludedClasses.some((name) => sameName(name, classification.name))) {
      violations.push(`${category.name} is not allowed at ${classification.name}`);
    }
    if (category.requiredClass !== null && !sameName(category.requiredClass, classification.name)) {
      violations.push(`${category.name} is only allowed at ${category.requiredClass}`);
    }
    for (const group of category.excludedCategories) {
      const clash = selected.find((other) => other !== entry && matchesGroup(other, group));
      if (clash !== undefined) {
        violations.push(`${category.name} cannot be combined with ${clash.category.name}`);
      }
    }
    for (const rule of category.requiredCategories) {
      if (!isSatisfied(rule, selected, entry)) {
        violations.push(`${category.name} requires ${describeRule(rule)}`);
      }
    }
  }
  return violations;
}

// `onlyOne` means exactly one matching category, as in spiffing.
function isSatisfied(rule: RequiredCategoryRule, selected: SelectedCategory[], owner: SelectedCategory | null): boolean {
  const others = selected.filter((entry) => entry !== owner);
  switch (rule.operation) {
    case 'all':
      return rule.groups.every((group) => others.some((entry) => matchesGroup(entry, group)));
    case 'oneOrMore':
      return others.some((entry) => rule.groups.some((group) => matchesGroup(entry, group)));
    case 'onlyOne':
      return others.filter((entry) => rule.groups.some((group) => matchesGroup(entry, group))).length === 1;
    default:
      return false;
  }
}

function matchesGroup(entry: SelectedCategory, group: CategoryGroup): boolean {
  return sameName(entry.tagSet.name, group.tagSet) && (group.lacv === null || entry.category.lacv === group.lacv);
}

function describeRule(rule: RequiredCategoryRule): string {
  const groups = rule.groups.map((group) => (group.lacv === null ? group.tagSet : `${group.tagSet} ${group.lacv}`));
  return `${rule.operation} of ${groups.join(', ')}`;
}

function buildLabel(policy: SecurityPolicy, classification: SecurityClassification, selected: SelectedCategory[]): Label {
  const categories: LabelCategory[] = [];
  for (const tagSet of policy.tagSets) {
    const values = tagSet.categories
      .filter((category) => selected.some((entry) => entry.category === category))
      .map((category) => category.name);
    if (values.length > 0) {
      categories.push({ tagSet: tagSet.name, type: tagSet.type, values });
    }
  }
  return { policy: policy.name, classification: classification.name, categories };
}

function* combinations(count: number, size: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === size) {
    yield prefix;
    return;
  }
  for (let index = start; index < count; index += 1) {
    yield* combinations(count, size, index + 1, [...prefix, index]);
  }
}

export function findClassification(policy: SecurityPolicy, name: string): SecurityClassification {
  const classification = policy.classifications.find((candidate) => sameName(candidate.name, name));
  if (classification === undefined) {
    throw new Error(`Label refers to unknown classification ${name}`);
  }
  return classification;
}

export function findTagSet(policy: SecurityPolicy, name: string): CategoryTagSet {
  const tagSet = policy.tagSets.find((candidate) => sameName(candidate.name, name));
  if (tagSet === undefined) {
    throw new Error(`Label refers to unknown tag set ${name}`);
  }
  return tagSet;
}

export function findCategory(tagSet: CategoryTagSet, name: string): TagCategory {
  const category = tagSet.categories.find((candidate) => sameName(candidate.name, name));
  if (category === undefined) {
    throw new Error(`Label refers to unknown category ${name} in ${tagSet.name}`);
  }
  return category;
}
