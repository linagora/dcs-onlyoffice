import type { PluginInfo } from './onlyoffice.ts';

// The stored document the editor shows, which the host names in the plugin's
// options.
export function documentIdOf(info: PluginInfo): string | null {
  const options = info.options;
  return typeof options === 'object' && options !== null && 'documentId' in options && typeof options.documentId === 'string'
    ? options.documentId
    : null;
}

// Tells the portal about a base label change the panel made: the portal logs
// it with the signed-in person and saves the document at once, since it
// checks who opens a document against the stored label.
export async function reportBaseLabelChange(documentId: string, before: string | null, after: string): Promise<void> {
  const response = await fetch(`/documents/${encodeURIComponent(documentId)}/base-label`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ before, after }),
  });
  if (!response.ok) {
    throw new Error(`The portal answered ${response.status}`);
  }
}
