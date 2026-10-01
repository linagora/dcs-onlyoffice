// A field of a JSON value, still unknown; null when the value is no object
// or has no such field.
export function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value ? (value as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
}
