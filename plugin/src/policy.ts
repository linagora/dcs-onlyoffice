// Client of the policy service, reached through the portal's relay.

export interface LabelCategory {
  tagSet: string;
  type: string;
  values: string[];
}

export interface Marking {
  text: string;
  color: string | null;
}

export interface LabelView {
  code: string;
  policy: string;
  classification: string;
  categories: LabelCategory[];
  marking: Marking;
}

const RELAY = '/api/policy';

// The panel works with the first policy the service declares.
export async function fetchDefaultPolicyLabels(): Promise<LabelView[]> {
  const policies = await getJson(`${RELAY}/policies`);
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new Error('The policy service declares no policy');
  }
  const first: unknown = policies[0];
  if (typeof first !== 'object' || first === null || !('name' in first) || typeof first.name !== 'string') {
    throw new Error('Unexpected policy list');
  }
  const labels = await getJson(`${RELAY}/policies/${encodeURIComponent(first.name)}/labels`);
  if (!Array.isArray(labels) || !labels.every(isLabelView)) {
    throw new Error('Unexpected label list');
  }
  return labels;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.json();
}

export function isLabelView(value: unknown): value is LabelView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>; // SAFETY: object checked above
  const marking = candidate.marking;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.classification === 'string' &&
    Array.isArray(candidate.categories) &&
    typeof marking === 'object' &&
    marking !== null &&
    'text' in marking &&
    typeof marking.text === 'string'
  );
}
