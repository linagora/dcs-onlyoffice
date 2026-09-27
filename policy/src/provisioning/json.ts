// Reading the JSON the provisioning job receives from the IdP, the policy
// service and OpenTDF: everything stays unknown until checked.

const REQUEST_TIMEOUT_MS = 30_000;

export interface JsonAnswer {
  status: number;
  body: unknown;
}

export async function fetchJson(url: string | URL, init: RequestInit = {}): Promise<JsonAnswer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

export function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value ? (value as Record<string, unknown>)[name] : null; // SAFETY: object checked
}

// Connect's JSON leaves out empty fields: a missing list is empty.
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function texts(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item: unknown): item is string => typeof item === 'string') ? value : null;
}
