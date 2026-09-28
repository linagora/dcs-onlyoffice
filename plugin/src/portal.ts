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
  await postReport(documentId, 'base-label', { before, after });
}

// A portion's label and version, before or after a change.
export interface PortionState {
  label: string;
  version: number | null;
}

// Tells the portal about a change of a portion the panel made, which the
// portal logs with the signed-in person. The report never holds the text.
export async function reportPortionChange(documentId: string, portionId: string, before: PortionState, after: PortionState): Promise<void> {
  await postReport(documentId, 'portion-change', { portion: portionId, before, after });
}

// Tells the portal about a portion the panel deleted, which the portal logs
// with the signed-in person and the portion's last label and version.
export async function reportPortionDeletion(documentId: string, portionId: string, before: PortionState): Promise<void> {
  await postReport(documentId, 'portion-deletion', { portion: portionId, before });
}

async function postReport(documentId: string, report: string, body: object): Promise<void> {
  const response = await fetch(`/documents/${encodeURIComponent(documentId)}/${report}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`The portal answered ${response.status}`);
  }
}
