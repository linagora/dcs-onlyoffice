import type { Element } from '@xmldom/xmldom';
import { requireTagSet, type Label, type LabelRequest } from './labels.ts';
import type { SecurityPolicy } from './spif/model.ts';
import { childElements, childrenNamed, parseXml } from './xml.ts';

export const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';

// The label an originator label designates: its policy's name and identifier,
// and the label in the policy's names, still to be validated against it.
export interface DesignatedLabel {
  policy: string;
  // The policy's OID as a URI, urn:oid:…, when the label gives it.
  policyUri: string | null;
  request: LabelRequest;
}

export interface LabelMetadata {
  creationDateTime: Date;
  reviewDateTime: Date;
  originatorEmail: string | null;
}

// Element order follows the ADatP-4774 XSD. ReviewDateTime is always written:
// the standard requires it when there is no SuccessionHandling. Category values
// are the SPIF names, never the lacv (ADatP-4774.1 Table 10).
export function serializeOriginatorLabel(policy: SecurityPolicy, label: Label, metadata: LabelMetadata): string {
  const categories = label.categories
    .map((category) => {
      const tagSet = requireTagSet(policy, category.tagSet);
      const values = category.values.map((value) => `<slab:GenericValue>${escapeXml(value)}</slab:GenericValue>`).join('');
      return `<slab:Category Type="${category.type}" TagName="${escapeXml(tagSet.name)}" URI="urn:oid:${escapeXml(tagSet.oid)}">${values}</slab:Category>`;
    })
    .join('');
  const originator =
    metadata.originatorEmail === null
      ? ''
      : `<slab:OriginatorID IDType="rfc822Name">${escapeXml(metadata.originatorEmail)}</slab:OriginatorID>`;
  return (
    `<slab:originatorConfidentialityLabel xmlns:slab="${LABEL_NAMESPACE}" ReviewDateTime="${formatDateTime(metadata.reviewDateTime)}">` +
    '<slab:ConfidentialityInformation>' +
    `<slab:PolicyIdentifier URI="urn:oid:${escapeXml(policy.oid)}">${escapeXml(policy.name)}</slab:PolicyIdentifier>` +
    `<slab:Classification>${escapeXml(label.classification)}</slab:Classification>` +
    categories +
    '</slab:ConfidentialityInformation>' +
    originator +
    `<slab:CreationDateTime>${formatDateTime(metadata.creationDateTime)}</slab:CreationDateTime>` +
    '</slab:originatorConfidentialityLabel>'
  );
}

// Reverse of serializeOriginatorLabel, for a label read from a file or an
// envelope. Null unless the XML is an originator label in the form this
// service writes: one policy identifier, one classification, and categories
// that hold generic values only.
export function readOriginatorLabel(xml: string): DesignatedLabel | null {
  const parsed = parseXml(xml);
  if (!parsed.ok || parsed.root.namespaceURI !== LABEL_NAMESPACE || parsed.root.localName !== 'originatorConfidentialityLabel') {
    return null;
  }
  const information = onlyChild(parsed.root, 'ConfidentialityInformation');
  if (information === null || !childElements(information).every((element) => isLabelElement(element, INFORMATION_ELEMENTS))) {
    return null;
  }
  const policyIdentifier = onlyChild(information, 'PolicyIdentifier');
  const policy = textOf(policyIdentifier);
  const classification = textOf(onlyChild(information, 'Classification'));
  if (policyIdentifier === null || policy === null || classification === null) {
    return null;
  }
  const categories: LabelRequest['categories'] = [];
  for (const category of childrenNamed(information, LABEL_NAMESPACE, 'Category')) {
    const tagSet = category.getAttribute('TagName');
    const valueElements = childElements(category);
    const values = valueElements.map(textOf);
    if (!tagSet || valueElements.length === 0 || !valueElements.every((element) => isLabelElement(element, ['GenericValue'])) || values.includes(null)) {
      return null;
    }
    categories.push({ tagSet, values: values.filter((value): value is string => value !== null) });
  }
  const policyUri = policyIdentifier.getAttribute('URI');
  return { policy, policyUri: policyUri === '' ? null : policyUri, request: { classification, categories } };
}

const INFORMATION_ELEMENTS: readonly string[] = ['PolicyIdentifier', 'Classification', 'Category'];

function isLabelElement(element: Element, localNames: readonly string[]): boolean {
  return element.namespaceURI === LABEL_NAMESPACE && localNames.includes(element.localName ?? '');
}

// The single child of that name, or null when there is none or several.
function onlyChild(parent: Element, localName: string): Element | null {
  const found = childrenNamed(parent, LABEL_NAMESPACE, localName);
  return found.length === 1 ? (found[0] ?? null) : null;
}

function textOf(element: Element | null): string | null {
  const text = element?.textContent?.trim() ?? '';
  return text === '' ? null : text;
}

// The standards leave the review period to the policy; the review falls at the
// start of the day in UTC.
export function reviewDateFor(creation: Date, reviewPeriodYears: number): Date {
  const review = new Date(creation.getTime());
  review.setUTCFullYear(review.getUTCFullYear() + reviewPeriodYears);
  review.setUTCHours(0, 0, 0, 0);
  return review;
}

function formatDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
