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

// ADatP-4774 XML of a label, created now for the calling user.
export async function fetchAdatp4774(policy: string, code: string): Promise<string> {
  const response = await fetch(`${RELAY}/policies/${encodeURIComponent(policy)}/labels/adatp4774`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    throw new Error(`The policy service refused label ${code} (${response.status})`);
  }
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('xml' in body) || typeof body.xml !== 'string') {
    throw new Error('Unexpected ADatP-4774 answer');
  }
  return body.xml;
}

export interface DocumentLabel {
  label: LabelView;
  moreRestrictivePortions: boolean;
  xml: string;
}

// What a document label is computed from.
export interface DocumentLabelRequest {
  policy: string;
  baseLabelCode: string;
  portionLabelCodes: string[];
}

// Document label computed from the base label and the portions' labels, with
// its ADatP-4778.2 binding part.
export async function fetchDocumentLabel(request: DocumentLabelRequest): Promise<DocumentLabel> {
  const response = await fetch(`${RELAY}/policies/${encodeURIComponent(request.policy)}/document-label`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: request.baseLabelCode, portions: request.portionLabelCodes }),
  });
  if (!response.ok) {
    throw new Error(`The policy service could not compute the document label (${response.status})`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('label' in body) ||
    !isLabelView(body.label) ||
    !('xml' in body) ||
    typeof body.xml !== 'string' ||
    !('moreRestrictivePortions' in body) ||
    typeof body.moreRestrictivePortions !== 'boolean'
  ) {
    throw new Error('Unexpected document label answer');
  }
  return { label: body.label, moreRestrictivePortions: body.moreRestrictivePortions, xml: body.xml };
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
    typeof candidate.policy === 'string' &&
    typeof candidate.classification === 'string' &&
    Array.isArray(candidate.categories) &&
    typeof marking === 'object' &&
    marking !== null &&
    'text' in marking &&
    typeof marking.text === 'string'
  );
}
