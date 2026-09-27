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
  return labelListOf(await getJson(`${RELAY}/policies/${encodeURIComponent(first.name)}/labels`));
}

// The base labels the signed-in person may give a document whose base label
// is `current`: anyone may raise it, only an administrator cleared for it may
// lower it.
export async function fetchBaseLabelChoices(policy: string, current: string | null): Promise<LabelView[]> {
  const query = current === null ? '' : `?current=${encodeURIComponent(current)}`;
  return labelListOf(await getJson(`${RELAY}/policies/${encodeURIComponent(policy)}/labels/base-choices${query}`));
}

// The labels of a policy that the signed-in person's clearance allows, which
// the policy service reads from the clearance directory.
export async function fetchAllowedLabels(policy: string): Promise<LabelView[]> {
  return labelListOf(await getJson(`${RELAY}/policies/${encodeURIComponent(policy)}/labels/allowed`));
}

function labelListOf(body: unknown): LabelView[] {
  if (!Array.isArray(body) || !body.every(isLabelView)) {
    throw new Error('Unexpected label list');
  }
  return body;
}

// ADatP-4774 XML of a label, created now for the calling user.
export async function fetchAdatp4774(policy: string, code: string): Promise<string> {
  const body = await postJson(`${RELAY}/policies/${encodeURIComponent(policy)}/labels/adatp4774`, { code }, `The policy service refused label ${code}`);
  if (typeof body !== 'object' || body === null || !('xml' in body) || typeof body.xml !== 'string') {
    throw new Error('Unexpected ADatP-4774 answer');
  }
  return body.xml;
}

// The label that an ADatP-4774 label designates, under the policy it names;
// null when the policy service finds no valid label in it.
export async function fetchLabelOfAdatp4774(xml: string): Promise<LabelView | null> {
  const response = await post(`${RELAY}/labels/parse`, { xml });
  if (response.status === 400 || response.status === 422) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`The policy service could not read a label (${response.status})`);
  }
  const body: unknown = await response.json();
  const label: unknown = typeof body === 'object' && body !== null && 'label' in body ? body.label : null;
  if (!isLabelView(label)) {
    throw new Error('Unexpected label answer');
  }
  return label;
}

// The attribute values an envelope carries for a label, which OpenTDF grants
// to the clearances that allow it.
export async function fetchLabelAttributes(policy: string, code: string): Promise<string[]> {
  const body = await postJson(
    `${RELAY}/policies/${encodeURIComponent(policy)}/labels/attributes`,
    { code },
    `The policy service gave no attributes for label ${code}`,
  );
  const attributes: unknown = typeof body === 'object' && body !== null && 'attributes' in body ? body.attributes : null;
  if (!Array.isArray(attributes) || !attributes.every((attribute: unknown): attribute is string => typeof attribute === 'string')) {
    throw new Error('Unexpected attributes answer');
  }
  return attributes;
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
  const body = await postJson(
    `${RELAY}/policies/${encodeURIComponent(request.policy)}/document-label`,
    { base: request.baseLabelCode, portions: request.portionLabelCodes },
    'The policy service could not compute the document label',
  );
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

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A refused call fails with the given message and the answer's status.
async function postJson(url: string, body: unknown, refusal: string): Promise<unknown> {
  const response = await post(url, body);
  if (!response.ok) {
    throw new Error(`${refusal} (${response.status})`);
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
