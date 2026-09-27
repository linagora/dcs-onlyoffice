import type { FastifyBaseLogger } from 'fastify';

const LOWERING_TIMEOUT_MS = 10_000;

// A change of a document's base label, from `before` to `after`, null when
// the document has none.
export interface BaseLabelChange {
  documentId: string;
  before: string | null;
  after: string | null;
}

// Any editor can change the base label in the file, and the panel offers
// lower labels only to administrators: the portal logs every lowering. The
// panel reports its own changes, with the person who made them; a save that
// lowers the label is logged too, with the users of its editing session,
// whatever made the change. Removing the base label counts as lowering it.
export class BaseLabelAudit {
  #policyUrl: string;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#log = log;
  }

  async recordReport(change: BaseLabelChange, user: string): Promise<void> {
    const lowering = await this.#lowering(change);
    this.#log.info({ ...change, user, lowering }, lowering === true ? 'Base label lowered in the panel' : 'Base label changed in the panel');
  }

  async recordSave(change: BaseLabelChange, sessionUsers: string[]): Promise<void> {
    const lowering = await this.#lowering(change);
    if (lowering === true) {
      this.#log.warn({ ...change, sessionUsers }, 'Base label lowered');
    } else if (lowering === null) {
      this.#log.warn({ ...change, sessionUsers }, 'Base label changed, and whether it was lowered is unknown');
    }
  }

  // Null when the policy service cannot tell.
  async #lowering({ before, after }: BaseLabelChange): Promise<boolean | null> {
    if (before === null || before === after) {
      return false;
    }
    if (after === null) {
      return true;
    }
    try {
      const response = await fetch(new URL('/labels/lowering', this.#policyUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: before, to: after }),
        signal: AbortSignal.timeout(LOWERING_TIMEOUT_MS),
      });
      const body: unknown = await response.json();
      if (!response.ok || typeof body !== 'object' || body === null || !('lowering' in body) || typeof body.lowering !== 'boolean') {
        throw new Error(`the policy service answered ${response.status}`);
      }
      return body.lowering;
    } catch (error: unknown) {
      this.#log.error({ before, after, err: error }, 'The policy service could not tell whether a base label is lowered');
      return null;
    }
  }
}
