// The plugin runs in the editor's iframe, whose browser console is its only
// log sink: problems go there as structured entries. Logging cannot fail, so
// the function returns nothing.
export function logProblem(activity: string, error: unknown): void {
  console.warn({ source: 'dcs-plugin', activity, message: describeError(error) });
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
