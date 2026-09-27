// Checks of the JSON the service receives, which stays unknown until checked.

// Array.isArray narrows to any[]; its items are unknown until checked.
export function unknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
