import { requireCategory, requireClassification, requireTagSet, type Label } from './labels.ts';
import type { MarkingPhrase, SecurityPolicy } from './spif/model.ts';

export interface Marking {
  text: string;
  color: string | null;
}

// Same composition as spiffing: policy (or its replacement phrase), then the
// classification, then each tag set's values between its prefix and suffix.
export function renderMarking(policy: SecurityPolicy, label: Label, language: string): Marking {
  const classification = requireClassification(policy, label.classification);
  const parts: string[] = [];
  const policyPart = policy.policyPhrase ?? policy.name;
  if (policyPart !== '') {
    parts.push(policyPart);
  }
  if (!hasCode(classification.markings, 'suppressClassName')) {
    parts.push(phraseFor(classification.markings, classification.name, language));
  }
  for (const labelCategory of label.categories) {
    const tagSet = requireTagSet(policy, labelCategory.tagSet);
    const values = labelCategory.values
      .map((value) => requireCategory(tagSet, value))
      .filter((category) => !hasCode(category.markings, 'noMarkingDisplay'))
      .map((category) => phraseFor(category.markings, category.name, language))
      .filter((phrase) => phrase !== '');
    if (values.length > 0) {
      const { prefix, separator, suffix } = tagSet.qualifiers;
      parts.push(`${prefix}${values.join(separator ?? '/')}${suffix}`);
    }
  }
  return { text: parts.join(policy.separator), color: classification.color };
}

// A phrase in the requested language wins, then a language-neutral phrase, then
// the name itself; phrases in other languages are never used.
function phraseFor(markings: MarkingPhrase[], name: string, language: string): string {
  if (hasCode(markings, 'noNameDisplay')) {
    return '';
  }
  const localized = markings.find(
    (marking) => marking.language !== null && marking.language.toLowerCase() === language.toLowerCase(),
  );
  if (localized !== undefined && localized.phrase !== '') {
    return localized.phrase;
  }
  const neutral = markings.find((marking) => marking.language === null && marking.phrase !== '');
  return neutral?.phrase ?? name;
}

function hasCode(markings: MarkingPhrase[], code: string): boolean {
  return markings.some((marking) => marking.codes.includes(code));
}
