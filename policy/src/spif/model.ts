// In-memory model of an Open XML SPIF (schema 2.1), reduced to what label
// validation and marking need.

export type CategoryType = 'RESTRICTIVE' | 'PERMISSIVE' | 'INFORMATIVE';

export type RuleOperation = 'onlyOne' | 'oneOrMore' | 'all';

export interface MarkingPhrase {
  phrase: string;
  language: string | null;
  codes: string[];
}

export interface MarkingQualifiers {
  prefix: string;
  separator: string | null;
  suffix: string;
}

// A group designates one category of a tag set (lacv) or the whole tag set.
export interface CategoryGroup {
  tagSet: string;
  lacv: number | null;
}

export interface RequiredCategoryRule {
  operation: RuleOperation;
  groups: CategoryGroup[];
}

export interface SecurityClassification {
  name: string;
  lacv: number;
  hierarchy: number;
  color: string | null;
  obsolete: boolean;
  markings: MarkingPhrase[];
  requiredCategories: RequiredCategoryRule[];
}

export interface TagCategory {
  name: string;
  lacv: number;
  obsolete: boolean;
  markings: MarkingPhrase[];
  excludedClasses: string[];
  requiredClass: string | null;
  requiredCategories: RequiredCategoryRule[];
  excludedCategories: CategoryGroup[];
}

export interface CategoryTagSet {
  name: string;
  oid: string;
  codeArc: string;
  type: CategoryType;
  singleSelection: boolean;
  maxSelection: number | null;
  categories: TagCategory[];
  qualifiers: MarkingQualifiers;
}

// Informative category added to a document label when some of its portions
// are more restrictive than its unprotected content (clear-parts rule).
export interface RollupIndicator {
  tagSet: string;
  category: string;
}

export interface SecurityPolicy {
  name: string;
  oid: string;
  rollupIndicator: RollupIndicator | null;
  classifications: SecurityClassification[];
  tagSets: CategoryTagSet[];
  policyPhrase: string | null;
  separator: string;
  sourceFile: string;
}
