// Reading JSON the tests receive: everything stays unknown until checked.

export function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value ? (value as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
}

export function arrayField(value: unknown, name: string): unknown[] {
  const found = field(value, name);
  return Array.isArray(found) ? found : [];
}

export function stringField(value: unknown, name: string): string | null {
  const found = field(value, name);
  return typeof found === 'string' ? found : null;
}
