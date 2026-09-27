import { categoryNamed, classificationNamed, policyNamed, tagSetNamed } from '../spif/lookup.ts';
import type { SecurityPolicy } from '../spif/model.ts';

// A category a clearance holds, named by its tag set and its own name.
export interface HeldCategory {
  tagSet: string;
  name: string;
}

// The terms of a clearance as a request gives them, before its security
// policy has checked them.
export interface ClearanceTermsRequest {
  classification: string;
  // Each "<tag set>:<category>".
  categories: string[];
}

// A clearance as a seed file or an administrator gives it.
export interface ClearanceRequest extends ClearanceTermsRequest {
  email: string;
  name: string;
  nationality: string | null;
  policy: string;
  validFrom: Date;
  validUntil: Date;
}

// What a clearance lets its holder read under its security policy: the
// highest classification and the categories held, every name spelled as the
// SPIF does, since OpenTDF matches names exactly.
export interface ClearanceTerms {
  classification: string;
  categories: HeldCategory[];
}

// What one person may read under one security policy.
export interface Clearance extends ClearanceTerms {
  email: string;
  name: string;
  // Shown to administrators only: no access rule reads it.
  nationality: string | null;
  policy: string;
  validFrom: Date;
  validUntil: Date;
}

export type ClearanceCheck = { ok: true; clearance: Clearance } | { ok: false; error: string };

export type ClearanceTermsCheck = { ok: true; terms: ClearanceTerms } | { ok: false; error: string };

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

// Reads back how the directory writes a held category, with the names as
// written. Tag set names hold no colon, which checkClearance makes sure of.
export function heldCategoryOf(text: string): HeldCategory | null {
  const separator = text.indexOf(QUALIFIER_SEPARATOR);
  return separator <= 0 ? null : { tagSet: text.slice(0, separator), name: text.slice(separator + 1) };
}

// The directory keeps email addresses in lower case.
export function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
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
  const email = normalizedEmail(request.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { ok: false, error: `${request.email} is not an email address` };
  }
  const policy = policyNamed(policies, request.policy);
  if (policy === null) {
    return { ok: false, error: `${email}: unknown security policy ${request.policy}` };
  }
  const read = readClearanceTerms(policy, request);
  if (!read.ok) {
    return { ok: false, error: `${email}: ${read.error}` };
  }
  const { classification, categories } = read.terms;
  const qualifiers = [policy.name, ...categories.map((held) => held.tagSet)];
  const names = [...qualifiers, classification, ...categories.map((held) => held.name)];
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
      classification,
      categories,
      validFrom: request.validFrom,
      validUntil: request.validUntil,
    },
  };
}

// Checks the terms of a clearance under a policy, and spells them as it does.
export function readClearanceTerms(policy: SecurityPolicy, request: ClearanceTermsRequest): ClearanceTermsCheck {
  const classification = classificationNamed(policy, request.classification);
  if (classification === null) {
    return { ok: false, error: `${policy.name} has no classification ${request.classification}` };
  }
  const categories: HeldCategory[] = [];
  for (const text of request.categories) {
    const written = heldCategoryOf(text);
    const tagSet = written === null ? null : tagSetNamed(policy, written.tagSet);
    const category = tagSet === null || written === null ? null : categoryNamed(tagSet, written.name);
    if (tagSet === null || category === null) {
      return { ok: false, error: `${policy.name} has no category ${text}` };
    }
    if (tagSet.type === 'INFORMATIVE') {
      return { ok: false, error: `the informative category ${tagSet.name}:${category.name} grants no access` };
    }
    if (!categories.some((held) => held.tagSet === tagSet.name && held.name === category.name)) {
      categories.push({ tagSet: tagSet.name, name: category.name });
    }
  }
  return { ok: true, terms: { classification: classification.name, categories } };
}
