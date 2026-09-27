import type { ClearanceTerms } from './directory/clearance.ts';
import type { Label } from './labels.ts';
import { classificationNamed, sameName } from './spif/lookup.ts';
import type { SecurityPolicy } from './spif/model.ts';

// The SPIF access control decision, as spiffing implements it: a clearance
// holds every classification up to its highest one, and must hold each
// restrictive category of the label and one value of each of its permissive
// categories. Informative categories play no part in it.
export function accessDecision(policy: SecurityPolicy, clearance: ClearanceTerms | null, label: Label): boolean {
  if (clearance === null) {
    return false;
  }
  const highest = classificationNamed(policy, clearance.classification);
  const required = classificationNamed(policy, label.classification);
  if (highest === null || required === null || required.hierarchy > highest.hierarchy) {
    return false;
  }
  const holds = (tagSet: string, value: string): boolean =>
    clearance.categories.some((held) => sameName(held.tagSet, tagSet) && sameName(held.name, value));
  return label.categories.every((category) => {
    switch (category.type) {
      case 'RESTRICTIVE':
        return category.values.every((value) => holds(category.tagSet, value));
      case 'PERMISSIVE':
        return category.values.some((value) => holds(category.tagSet, value));
      default:
        return true;
    }
  });
}
