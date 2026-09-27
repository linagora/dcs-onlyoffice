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

// The string fields of that name, in a list of objects.
export function stringsOf(values: unknown[], name: string): string[] {
  return values.map((value) => stringField(value, name)).filter((found): found is string => found !== null);
}
