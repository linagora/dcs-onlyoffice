// A field of a record read from outside the service, still unknown.
export function fieldOf(record: unknown, name: string): unknown {
  return typeof record === 'object' && record !== null && name in record ? (record as Record<string, unknown>)[name] : null; // SAFETY: object checked
}
