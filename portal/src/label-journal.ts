import type { FastifyBaseLogger } from 'fastify';
import type { FileLabels } from './document-labels.ts';

const LOWERING_TIMEOUT_MS = 10_000;

// A change of a document's base label, from `before` to `after`, null when
// the document has none.
export interface BaseLabelChange {
  documentId: string;
  before: string | null;
  after: string | null;
}

// A portion's label and version, as the portion's part in the file holds
// them; the version is null in a part older than versions.
export interface PortionState {
  label: string;
  version: number | null;
}

// A change of a protected portion the panel made: of its text, its label or
// both. The journal never holds a portion's text.
export interface PortionChange {
  documentId: string;
  portion: string;
  before: PortionState;
  after: PortionState;
}

// The journal of label changes, in the portal's log. Any editor can change a
// label in the file, and the panel offers lower ones only to administrators:
// the portal logs every lowering. The panel reports its own changes, with the
// person who made them; a save that lowers a label is logged too, with the
// users of its editing session, whatever made the change. Removing the base
// label counts as lowering it.
export class LabelJournal {
  #policyUrl: string;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#log = log;
  }

  async recordBaseLabelReport(change: BaseLabelChange, user: string): Promise<void> {
    const lowering = await this.#lowering(change.before, change.after);
    this.#recordReport({ ...change, user }, lowering, { changed: 'Base label changed in the panel', lowered: 'Base label lowered in the panel' });
  }

  async recordPortionReport(change: PortionChange, user: string): Promise<void> {
    const lowering = await this.#lowering(change.before.label, change.after.label);
    this.#recordReport({ ...change, user }, lowering, { changed: 'Portion changed in the panel', lowered: 'Portion label lowered in the panel' });
  }

  // What a save changed in the labels in clear of a stored file: its base
  // label, and the labels of the portions it already held.
  async recordSave(documentId: string, before: FileLabels, after: FileLabels, sessionUsers: string[]): Promise<void> {
    const baseLowering = await this.#lowering(before.base, after.base);
    this.#recordSaved({ documentId, before: before.base, after: after.base, sessionUsers }, baseLowering, 'Base label');
    for (const [portion, labels] of after.portions) {
      const previous = before.portions.get(portion);
      if (previous !== undefined) {
        const lowerings = await Promise.all([this.#lowering(previous.part, labels.part), this.#lowering(previous.tag, labels.tag)]);
        const lowering = lowerings.includes(true) ? true : lowerings.includes(null) ? null : false;
        this.#recordSaved({ documentId, portion, before: previous, after: labels, sessionUsers }, lowering, 'Portion label');
      }
    }
  }

  // Every change the panel reports is logged.
  #recordReport(entry: object, lowering: boolean | null, messages: { changed: string; lowered: string }): void {
    if (lowering === null) {
      this.#log.warn({ ...entry, lowering }, `${messages.changed}, and whether it was lowered is unknown`);
    } else {
      this.#log.info({ ...entry, lowering }, lowering ? messages.lowered : messages.changed);
    }
  }

  // Only lowerings, and labels that may be lowered, are logged.
  #recordSaved(entry: object, lowering: boolean | null, subject: 'Base label' | 'Portion label'): void {
    if (lowering === true) {
      this.#log.warn(entry, `${subject} lowered`);
    } else if (lowering === null) {
      this.#log.warn(entry, `${subject} changed, and whether it was lowered is unknown`);
    }
  }

  // Null when the policy service cannot tell.
  async #lowering(before: string | null, after: string | null): Promise<boolean | null> {
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
      this.#log.error({ before, after, err: error }, 'The policy service could not tell whether a label is lowered');
      return null;
    }
  }
}
