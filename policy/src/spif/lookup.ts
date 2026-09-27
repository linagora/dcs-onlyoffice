import type { CategoryTagSet, SecurityClassification, SecurityPolicy, TagCategory } from './model.ts';

// Names in a SPIF match without regard to case.
export function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

export function classificationNamed(policy: SecurityPolicy, name: string): SecurityClassification | null {
  return policy.classifications.find((candidate) => sameName(candidate.name, name)) ?? null;
}

export function tagSetNamed(policy: SecurityPolicy, name: string): CategoryTagSet | null {
  return policy.tagSets.find((candidate) => sameName(candidate.name, name)) ?? null;
}

export function categoryNamed(tagSet: CategoryTagSet, name: string): TagCategory | null {
  return tagSet.categories.find((candidate) => sameName(candidate.name, name)) ?? null;
}
