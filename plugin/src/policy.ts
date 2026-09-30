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

// The labels the signed-in person may give a portion whose label is
// `current`: those their clearance allows, raising it only, unless they are
// an administrator cleared for it.
export async function fetchPortionLabelChoices(policy: string, current: string): Promise<LabelView[]> {
  return labelListOf(await getJson(`${RELAY}/policies/${encodeURIComponent(policy)}/labels/portion-choices?current=${encodeURIComponent(current)}`));
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

// The format of a document, whose parts its binding references.
export type PackageKind = 'text-document' | 'workbook';

// Document label computed from the base label and the portions' labels, with
// its ADatP-4778.2 binding part, over the parts of the document's format.
export async function fetchDocumentLabel(request: DocumentLabelRequest, packageKind: PackageKind): Promise<DocumentLabel> {
  const body = await postJson(
    `${RELAY}/policies/${encodeURIComponent(request.policy)}/document-label`,
    { base: request.baseLabelCode, portions: request.portionLabelCodes, packageKind },
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

export interface LockHolder {
  id: string;
  name: string;
}

// A held lock comes with its lease and the last portion version a released
// lock reported; a taken one with its holder, unknown when the lock lapsed.
export type LockOutcome =
  | { status: 'held'; leaseMs: number; version: number | null }
  | { status: 'taken'; holder: LockHolder | null }
  | { status: 'refused' };

// Takes the lock of a portion for the signed-in person or, with `renewal`,
// renews the one they still hold. The policy service gives it only when their
// clearance allows the portion's label.
export async function takePortionLock(documentId: string, portionId: string, labelCode: string, renewal: boolean): Promise<LockOutcome> {
  const response = await post(lockUrl(documentId, portionId), { code: labelCode, renewal });
  const body: unknown = response.status === 200 || response.status === 409 ? await response.json() : null;
  if (response.status === 200 && typeof body === 'object' && body !== null && 'leaseMs' in body && typeof body.leaseMs === 'number') {
    const version = 'version' in body && typeof body.version === 'number' ? body.version : null;
    return { status: 'held', leaseMs: body.leaseMs, version };
  }
  if (response.status === 409 && typeof body === 'object' && body !== null && 'holder' in body && (body.holder === null || isLockHolder(body.holder))) {
    return { status: 'taken', holder: body.holder };
  }
  if (response.status === 403) {
    return { status: 'refused' };
  }
  throw new Error(`Taking the portion lock answered ${response.status}`);
}

// Releases a lock; after a change, with the version the change wrote.
export async function releasePortionLock(documentId: string, portionId: string, version: number | null): Promise<void> {
  const response = await post(`${lockUrl(documentId, portionId)}/release`, version === null ? {} : { version });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Releasing the portion lock answered ${response.status}`);
  }
}

// Releases a lock as the panel goes away, when an ordinary request could be
// cut short.
export function releasePortionLockOnLeave(documentId: string, portionId: string): void {
  navigator.sendBeacon(`${lockUrl(documentId, portionId)}/release`, new Blob(['{}'], { type: 'application/json' }));
}

// Who holds each locked portion of a document, by portion id, and the labels
// among those asked that the signed-in person may read now, as the policy
// service decides from their clearance in the clearance directory.
export interface PortionLocksAnswer {
  locks: ReadonlyMap<string, LockHolder>;
  readable: ReadonlySet<string>;
}

export async function fetchPortionLocks(documentId: string, labelCodes: string[]): Promise<PortionLocksAnswer> {
  const query = new URLSearchParams(labelCodes.map((code): [string, string] => ['label', code])).toString();
  const body = await getJson(`${RELAY}/documents/${encodeURIComponent(documentId)}/locks${query === '' ? '' : `?${query}`}`);
  const entries: unknown = typeof body === 'object' && body !== null && 'locks' in body ? body.locks : null;
  const readable: unknown = typeof body === 'object' && body !== null && 'readable' in body ? body.readable : null;
  if (!Array.isArray(entries) || !Array.isArray(readable)) {
    throw new Error('Unexpected lock list');
  }
  const locks = new Map<string, LockHolder>();
  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null && 'portion' in entry && typeof entry.portion === 'string' && 'holder' in entry && isLockHolder(entry.holder)) {
      locks.set(entry.portion, entry.holder);
    }
  }
  return { locks, readable: new Set(readable.filter((code: unknown): code is string => typeof code === 'string')) };
}

function lockUrl(documentId: string, portionId: string): string {
  return `${RELAY}/documents/${encodeURIComponent(documentId)}/portions/${encodeURIComponent(portionId)}/lock`;
}

function isLockHolder(value: unknown): value is LockHolder {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'name' in value && typeof value.name === 'string';
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
