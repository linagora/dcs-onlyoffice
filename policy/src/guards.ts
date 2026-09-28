// Checks of the JSON the service receives, which stays unknown until checked.

// Array.isArray narrows to any[]; its items are unknown until checked.
export function unknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

// A text field of a JSON object, null when absent or of another type.
export function readTextField(body: unknown, name: string): string | null {
  const value: unknown = typeof body === 'object' && body !== null && name in body ? (body as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
  return typeof value === 'string' ? value : null;
}

// A field of a JSON object, still unknown.
export function readField(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body ? (body as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
}
