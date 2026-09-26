import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type {
  CategoryGroup,
  CategoryTagSet,
  CategoryType,
  MarkingPhrase,
  MarkingQualifiers,
  RequiredCategoryRule,
  RuleOperation,
  SecurityClassification,
  SecurityPolicy,
  TagCategory,
} from './model.ts';

export const SPIF_NAMESPACE = 'http://www.xmlspif.org/spif';

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const ELEMENT_NODE = 1;
const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ['2.0', '2.1'];
const RULE_OPERATIONS: readonly string[] = ['onlyOne', 'oneOrMore', 'all'];

// The W3C colour names allowed by the SPIF 2.1 schema, which misspells fuchsia.
const NAMED_COLORS: Readonly<Record<string, string>> = {
  aqua: '#00FFFF',
  black: '#000000',
  blue: '#0000FF',
  fuchsia: '#FF00FF',
  fuschia: '#FF00FF',
  gray: '#808080',
  green: '#008000',
  lime: '#00FF00',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  purple: '#800080',
  red: '#FF0000',
  silver: '#C0C0C0',
  teal: '#008080',
  white: '#FFFFFF',
  yellow: '#FFFF00',
};

export class SpifError extends Error {}

export async function loadPolicies(directory: string): Promise<SecurityPolicy[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.xml')).sort();
  if (files.length === 0) {
    throw new SpifError(`No SPIF file in ${directory}`);
  }
  const policies: SecurityPolicy[] = [];
  for (const file of files) {
    const policy = parseSpif(await readFile(path.join(directory, file), 'utf8'), file);
    if (policies.some((existing) => sameName(existing.name, policy.name))) {
      throw new SpifError(`${file}: policy ${policy.name} is already defined by another SPIF`);
    }
    policies.push(policy);
  }
  return policies;
}

export function parseSpif(xml: string, sourceFile: string): SecurityPolicy {
  try {
    return readPolicy(parseXml(xml), sourceFile);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpifError(`${sourceFile}: ${reason}`, { cause: error });
  }
}

export function sameName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function parseXml(xml: string): Element {
  // SPIF files never need a DTD; refusing them rules out entity expansion attacks.
  if (/<!DOCTYPE/i.test(xml)) {
    throw new SpifError('DTDs are not allowed');
  }
  const problems: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') {
        problems.push(message);
      }
    },
  }).parseFromString(xml, 'text/xml');
  if (problems.length > 0 || document.documentElement === null) {
    throw new SpifError(`not well-formed XML (${problems.join('; ')})`);
  }
  return document.documentElement;
}

function readPolicy(root: Element, sourceFile: string): SecurityPolicy {
  if (root.namespaceURI !== SPIF_NAMESPACE || root.localName !== 'SPIF') {
    throw new SpifError(`the root element must be SPIF in namespace ${SPIF_NAMESPACE}`);
  }
  const schemaVersion = requiredAttribute(root, 'schemaVersion');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new SpifError(`SPIF schema ${schemaVersion} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
  }
  const policyId = requiredChild(root, 'securityPolicyId');
  const classifications = children(requiredChild(root, 'securityClassifications'), 'securityClassification').map(
    readClassification,
  );
  if (classifications.length === 0) {
    throw new SpifError('the SPIF defines no classification');
  }
  const tagSetsElement = optionalChild(root, 'securityCategoryTagSets');
  const tagSets = tagSetsElement === null ? [] : children(tagSetsElement, 'securityCategoryTagSet').map(readTagSet);
  const policy: SecurityPolicy = {
    name: requiredAttribute(policyId, 'name'),
    oid: requiredAttribute(policyId, 'id'),
    classifications,
    tagSets,
    policyPhrase: readPolicyPhrase(root),
    separator: readQualifiers(root).separator ?? ' ',
    sourceFile,
  };
  checkConsistency(policy);
  return policy;
}

function readClassification(element: Element): SecurityClassification {
  const color = element.getAttribute('color');
  return {
    name: requiredAttribute(element, 'name'),
    lacv: integerAttribute(element, 'lacv'),
    hierarchy: integerAttribute(element, 'hierarchy'),
    color: color === null || color === '' ? null : normalizeColor(color),
    obsolete: element.getAttribute('obsolete') === 'true',
    markings: readMarkings(element),
    requiredCategories: children(element, 'requiredCategory').map(readRequiredCategory),
  };
}

function readTagSet(element: Element): CategoryTagSet {
  const name = requiredAttribute(element, 'name');
  const tags = children(element, 'securityCategoryTag');
  if (tags.length !== 1 || tags[0] === undefined) {
    throw new SpifError(`tag set ${name} must hold exactly one securityCategoryTag`);
  }
  const tag = tags[0];
  const oid = requiredAttribute(element, 'id');
  const maxSelection = tag.getAttribute('maxSelection');
  return {
    name,
    oid,
    codeArc: oid.slice(oid.lastIndexOf('.') + 1),
    type: categoryType(tag, name),
    singleSelection: tag.getAttribute('singleSelection') === 'true',
    maxSelection: maxSelection === null || maxSelection === '' ? null : Number.parseInt(maxSelection, 10),
    categories: children(tag, 'tagCategory').map(readTagCategory),
    qualifiers: readQualifiers(tag),
  };
}

function readTagCategory(element: Element): TagCategory {
  const requiredClass = element.getAttribute('requiredClass');
  return {
    name: requiredAttribute(element, 'name'),
    lacv: integerAttribute(element, 'lacv'),
    obsolete: element.getAttribute('obsolete') === 'true',
    markings: readMarkings(element),
    excludedClasses: children(element, 'excludedClass').map((excluded) => (excluded.textContent ?? '').trim()),
    requiredClass: requiredClass === null || requiredClass === '' ? null : requiredClass,
    requiredCategories: children(element, 'requiredCategory').map(readRequiredCategory),
    excludedCategories: children(element, 'excludedCategory').map(readCategoryGroup),
  };
}

// ADatP-4774.1 section 3.3.4: enumerated tags take the type of their enumType,
// and tagType7 carries informative categories.
function categoryType(tag: Element, tagSetName: string): CategoryType {
  const tagType = requiredAttribute(tag, 'tagType');
  const effective = tagType === 'enumerated' ? requiredAttribute(tag, 'enumType') : tagType;
  switch (effective) {
    case 'restrictive':
      return 'RESTRICTIVE';
    case 'permissive':
      return 'PERMISSIVE';
    case 'tagType7':
      return 'INFORMATIVE';
    default:
      throw new SpifError(`tag set ${tagSetName} has an unsupported tag type ${tagType}`);
  }
}

function readRequiredCategory(element: Element): RequiredCategoryRule {
  const operation = requiredAttribute(element, 'operation');
  if (!RULE_OPERATIONS.includes(operation)) {
    throw new SpifError(`unknown requiredCategory operation ${operation}`);
  }
  return {
    operation: operation as RuleOperation, // SAFETY: membership checked above
    groups: children(element, 'categoryGroup').map(readCategoryGroup),
  };
}

// A group without lacv designates the whole tag set (`all="true"` or omitted).
function readCategoryGroup(element: Element): CategoryGroup {
  const lacv = element.getAttribute('lacv');
  return {
    tagSet: requiredAttribute(element, 'tagSetRef'),
    lacv: lacv === null || lacv === '' ? null : Number.parseInt(lacv, 10),
  };
}

function readMarkings(element: Element): MarkingPhrase[] {
  return children(element, 'markingData').map((marking) => ({
    phrase: marking.getAttribute('phrase') ?? '',
    language: marking.getAttributeNS(XML_NAMESPACE, 'lang') || null,
    codes: children(marking, 'code').map((code) => (code.textContent ?? '').trim()),
  }));
}

function readQualifiers(element: Element): MarkingQualifiers {
  const qualifiers: MarkingQualifiers = { prefix: '', separator: null, suffix: '' };
  const markingQualifier = children(element, 'markingQualifier')[0];
  if (markingQualifier === undefined) {
    return qualifiers;
  }
  for (const qualifier of children(markingQualifier, 'qualifier')) {
    const text = qualifier.getAttribute('markingQualifier') ?? '';
    switch (qualifier.getAttribute('qualifierCode')) {
      case 'prefix':
        qualifiers.prefix = text;
        break;
      case 'separator':
        qualifiers.separator = text;
        break;
      case 'suffix':
        qualifiers.suffix = text;
        break;
      default:
        break;
    }
  }
  return qualifiers;
}

// SPIF-level markingData with the replacePolicy code replaces the policy name in
// markings; an empty phrase removes it, as French markings do.
function readPolicyPhrase(root: Element): string | null {
  const replacement = readMarkings(root).find((marking) => marking.codes.includes('replacePolicy'));
  return replacement === undefined ? null : replacement.phrase;
}

function checkConsistency(policy: SecurityPolicy): SecurityPolicy {
  assertUnique(policy.classifications.map((classification) => classification.name.toUpperCase()), 'classification name');
  assertUnique(policy.classifications.map((classification) => String(classification.lacv)), 'classification lacv');
  assertUnique(policy.tagSets.map((tagSet) => tagSet.name.toUpperCase()), 'tag set name');
  assertUnique(policy.tagSets.map((tagSet) => tagSet.codeArc), 'tag set OID last arc');
  for (const tagSet of policy.tagSets) {
    assertUnique(tagSet.categories.map((category) => category.name.toUpperCase()), `category name in ${tagSet.name}`);
    assertUnique(tagSet.categories.map((category) => String(category.lacv)), `category lacv in ${tagSet.name}`);
    for (const category of tagSet.categories) {
      for (const classificationName of [...category.excludedClasses, ...(category.requiredClass === null ? [] : [category.requiredClass])]) {
        if (!policy.classifications.some((classification) => sameName(classification.name, classificationName))) {
          throw new SpifError(`category ${category.name} refers to unknown classification ${classificationName}`);
        }
      }
      const groups = [
        ...category.excludedCategories,
        ...category.requiredCategories.flatMap((rule) => rule.groups),
      ];
      for (const group of groups) {
        if (!policy.tagSets.some((candidate) => sameName(candidate.name, group.tagSet))) {
          throw new SpifError(`category ${category.name} refers to unknown tag set ${group.tagSet}`);
        }
      }
    }
  }
  return policy;
}

function assertUnique(values: string[], what: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new SpifError(`duplicate ${what} ${value}`);
    }
    seen.add(value);
  }
  return values;
}

function normalizeColor(color: string): string {
  const named = NAMED_COLORS[color.toLowerCase()];
  if (named !== undefined) {
    return named;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return color.toUpperCase();
  }
  throw new SpifError(`unsupported colour ${color}`);
}

function children(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element; // SAFETY: nodeType identifies an element
      if (element.namespaceURI === SPIF_NAMESPACE && element.localName === localName) {
        result.push(element);
      }
    }
  }
  return result;
}

function optionalChild(parent: Element, localName: string): Element | null {
  return children(parent, localName)[0] ?? null;
}

function requiredChild(parent: Element, localName: string): Element {
  const child = optionalChild(parent, localName);
  if (child === null) {
    throw new SpifError(`missing element ${localName} in ${parent.localName}`);
  }
  return child;
}

function requiredAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value === null || value === '') {
    throw new SpifError(`missing attribute ${name} on ${element.localName}`);
  }
  return value;
}

function integerAttribute(element: Element, name: string): number {
  const value = Number.parseInt(requiredAttribute(element, name), 10);
  if (!Number.isInteger(value)) {
    throw new SpifError(`attribute ${name} on ${element.localName} must be an integer`);
  }
  return value;
}
