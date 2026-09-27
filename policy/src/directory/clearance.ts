import { categoryNamed, classificationNamed, policyNamed, tagSetNamed } from '../spif/lookup.ts';
import type { SecurityPolicy } from '../spif/model.ts';

// A category a clearance holds, named by its tag set and its own name.
export interface HeldCategory {
  tagSet: string;
  name: string;
}

// A clearance as a seed file or an administrator gives it, before its security
// policy has checked it.
export interface ClearanceRequest {
  email: string;
  name: string;
  nationality: string | null;
  policy: string;
  classification: string;
  // Each "<tag set>:<category>".
  categories: string[];
  validFrom: Date;
  validUntil: Date;
}

// What one person may read under one security policy, every name spelled as
// the SPIF does, since OpenTDF matches names exactly.
export interface Clearance {
  email: string;
  name: string;
  // Shown to administrators only: no access rule reads it.
  nationality: string | null;
  policy: string;
  classification: string;
  categories: HeldCategory[];
  validFrom: Date;
  validUntil: Date;
}

export type ClearanceCheck = { ok: true; clearance: Clearance } | { ok: false; error: string };

// OpenTDF's entity resolution turns the clearances valid now into two claims
// (see deploy/opentdf/opentdf.yaml): "classifications", each
// "<policy>:<classification>", and "categories", each
// "<policy>:<tag set>:<category>", both lists joined by commas. Names can
// therefore hold no comma, and qualifiers no colon.
const LIST_SEPARATOR = ',';
const QUALIFIER_SEPARATOR = ':';

export const CLASSIFICATIONS_CLAIM = 'classifications';
export const CATEGORIES_CLAIM = 'categories';

// How the directory writes a held category: "<tag set>:<category>".
export function categoryText(category: HeldCategory): string {
  return `${category.tagSet}${QUALIFIER_SEPARATOR}${category.name}`;
}

// The value of the classifications claim that stands for a classification.
export function classificationClaim(policy: string, classification: string): string {
  return `${policy}${QUALIFIER_SEPARATOR}${classification}`;
}

// The value of the categories claim that stands for a held category.
export function categoryClaim(policy: string, category: HeldCategory): string {
  return `${policy}${QUALIFIER_SEPARATOR}${categoryText(category)}`;
}

export function checkClearance(request: ClearanceRequest, policies: SecurityPolicy[]): ClearanceCheck {
  const email = request.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { ok: false, error: `${request.email} is not an email address` };
  }
  const policy = policyNamed(policies, request.policy);
  if (policy === null) {
    return { ok: false, error: `${email}: unknown security policy ${request.policy}` };
  }
  const classification = classificationNamed(policy, request.classification);
  if (classification === null) {
    return { ok: false, error: `${email}: ${policy.name} has no classification ${request.classification}` };
  }
  const categories: HeldCategory[] = [];
  for (const text of request.categories) {
    const separator = text.indexOf(QUALIFIER_SEPARATOR);
    const tagSet = separator <= 0 ? null : tagSetNamed(policy, text.slice(0, separator));
    const category = tagSet === null ? null : categoryNamed(tagSet, text.slice(separator + 1));
    if (tagSet === null || category === null) {
      return { ok: false, error: `${email}: ${policy.name} has no category ${text}` };
    }
    if (tagSet.type === 'INFORMATIVE') {
      return { ok: false, error: `${email}: the informative category ${tagSet.name}:${category.name} grants no access` };
    }
    if (!categories.some((held) => held.tagSet === tagSet.name && held.name === category.name)) {
      categories.push({ tagSet: tagSet.name, name: category.name });
    }
  }
  const qualifiers = [policy.name, ...categories.map((held) => held.tagSet)];
  const names = [...qualifiers, classification.name, ...categories.map((held) => held.name)];
  if (names.some((name) => name.includes(LIST_SEPARATOR)) || qualifiers.some((name) => name.includes(QUALIFIER_SEPARATOR))) {
    return { ok: false, error: `${email}: the clearance directory cannot hold names that contain its separators` };
  }
  if (!(request.validFrom < request.validUntil)) {
    return { ok: false, error: `${email}: the validity period ends before it starts` };
  }
  return {
    ok: true,
    clearance: {
      email,
      name: request.name,
      nationality: request.nationality,
      policy: policy.name,
      classification: classification.name,
      categories,
      validFrom: request.validFrom,
      validUntil: request.validUntil,
    },
  };
}
