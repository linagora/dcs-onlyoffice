import type { FastifyBaseLogger } from 'fastify';
import type { UserIdentity } from './auth/sessions.ts';
import type { FileLabels, StoredLabels } from './document-labels.ts';
import type { StoredDocument } from './documents.ts';
import { identityHeaders } from './policy-relay.ts';

export interface Marking {
  text: string;
  color: string | null;
}

// What a person may do with a stored document: open it, or see only the
// marking of its base label, since its name can be sensitive too. When the
// decision cannot be made, the document stays closed.
export type DocumentDecision =
  | { open: true }
  | { open: false; reason: 'clearance'; marking: Marking | null }
  | { open: false; reason: 'unavailable' };

const DECISION_TIMEOUT_MS = 10_000;

// The portal decides nothing: the policy service decides, from the person's
// clearance and each document's base label, which covers its content in
// clear, whether the document opens for them. It also gives the marking of
// the document label a stored workbook names, which the workbook's page shows
// as it opens.
export class DocumentAccessCheck {
  #policyUrl: string;
  #storedLabels: StoredLabels;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, storedLabels: StoredLabels, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#storedLabels = storedLabels;
    this.#log = log;
  }

  async decide(user: UserIdentity, documents: StoredDocument[]): Promise<DocumentDecision[]> {
    const codes = await Promise.all(documents.map(async (document) => (await this.#storedLabelsOf(document))?.base));
    const readable = codes.filter((code): code is string | null => code !== undefined);
    const decisions = readable.length === 0 ? [] : await this.#decisions(user, readable);
    let next = 0;
    return codes.map((code): DocumentDecision => {
      if (code === undefined || decisions === null) {
        return { open: false, reason: 'unavailable' };
      }
      const decision = decisions[next];
      next += 1;
      if (decision === undefined) {
        return { open: false, reason: 'unavailable' };
      }
      return decision.granted ? { open: true } : { open: false, reason: 'clearance', marking: decision.marking };
    });
  }

  async decideOne(user: UserIdentity, document: StoredDocument): Promise<DocumentDecision> {
    const [decision] = await this.decide(user, [document]);
    return decision ?? { open: false, reason: 'unavailable' };
  }

  // The marking of the document label the stored file names, which the page
  // around a workbook's editor shows until the panel tells it the label it
  // computes; a file that names none counts as the least restrictive label.
  // Null when the file or the policy service cannot tell.
  async documentLabelMarkingOf(user: UserIdentity, document: StoredDocument): Promise<Marking | null> {
    const labels = await this.#storedLabelsOf(document);
    const [decision] = labels === undefined ? [] : ((await this.#decisions(user, [labels.label])) ?? []);
    return decision?.marking ?? null;
  }

  // Undefined when the stored file cannot be read.
  async #storedLabelsOf(document: StoredDocument): Promise<Pick<FileLabels, 'base' | 'label'> | undefined> {
    try {
      return await this.#storedLabels.of(document);
    } catch (error: unknown) {
      this.#log.error({ documentId: document.id, err: error }, 'The labels of a stored document could not be read');
      return undefined;
    }
  }

  async #decisions(user: UserIdentity, codes: (string | null)[]): Promise<PolicyDecision[] | null> {
    try {
      const response = await fetch(new URL('/labels/decisions', this.#policyUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...identityHeaders(user) },
        body: JSON.stringify({ codes }),
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
      const body: unknown = await response.json();
      const decisions: unknown = typeof body === 'object' && body !== null && 'decisions' in body ? body.decisions : null;
      if (!response.ok || !Array.isArray(decisions) || decisions.length !== codes.length) {
        throw new Error(`the policy service answered ${response.status}`);
      }
      return decisions.map(policyDecisionOf);
    } catch (error: unknown) {
      this.#log.error({ err: error }, 'The policy service could not decide on the labels of documents');
      return null;
    }
  }
}

interface PolicyDecision {
  granted: boolean;
  marking: Marking | null;
}

// An answer that is not a decision refuses.
function policyDecisionOf(value: unknown): PolicyDecision {
  if (typeof value !== 'object' || value === null || !('granted' in value) || value.granted !== true) {
    return { granted: false, marking: markingOf(value) };
  }
  return { granted: true, marking: markingOf(value) };
}

function markingOf(decision: unknown): Marking | null {
  const label: unknown = typeof decision === 'object' && decision !== null && 'label' in decision ? decision.label : null;
  return markingOfLabel(label);
}

// The marking of a label as the policy service shows it, null when it shows
// none.
export function markingOfLabel(label: unknown): Marking | null {
  const marking: unknown = typeof label === 'object' && label !== null && 'marking' in label ? label.marking : null;
  if (typeof marking !== 'object' || marking === null || !('text' in marking) || typeof marking.text !== 'string') {
    return null;
  }
  const color: unknown = 'color' in marking ? marking.color : null;
  return { text: marking.text, color: typeof color === 'string' ? color : null };
}
