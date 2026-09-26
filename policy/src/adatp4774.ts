import { findTagSet, type Label } from './labels.ts';
import type { SecurityPolicy } from './spif/model.ts';

export const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';

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
      const tagSet = findTagSet(policy, category.tagSet);
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
