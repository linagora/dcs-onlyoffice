import type { EnvelopeOpener, OpenedEnvelope } from './envelopes.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';
import { envelopeBytes, type StoredPortion } from './portions.ts';

// What the panel knows of an ADatP-4774 label once the policy service has read
// it: the label it designates, none when it designates no valid label, or
// nothing yet when the service could not be asked.
export type LabelReading = { status: 'read'; label: LabelView } | { status: 'invalid' } | { status: 'unchecked' };

// What the panel can show of a portion. An opened portion comes with the label
// bound to its envelope and the label in clear in its part.
export type PortionReading =
  | { status: 'opened'; text: string; boundLabel: LabelReading; partLabel: LabelReading }
  | Exclude<OpenedEnvelope, { status: 'opened' }>
  | { status: 'unencrypted'; text: string | null }
  | { status: 'unavailable' };

// Reads the label an ADatP-4774 label designates, null when it designates no
// valid label; fails when the policy service cannot be asked.
export type LabelReader = (xml: string) => Promise<LabelView | null>;

// Opens each envelope once while the panel is open. What cannot change is
// kept, keyed by the envelope itself so that a changed envelope is opened
// again: a text, a refusal, a damaged envelope. A failure worth retrying is
// not kept, so a later reading retries it. Labels are read once too, by their
// XML, except when the policy service could not be asked: a later reading
// asks again, without opening the envelope again.
export class PortionReader {
  #opener: EnvelopeOpener;
  #readLabel: LabelReader;
  #kept = new Map<string, OpenedEnvelope>();
  #opening = new Map<string, Promise<OpenedEnvelope>>();
  #labels = new Map<string, LabelReading>();

  constructor(opener: EnvelopeOpener, readLabel: LabelReader) {
    this.#opener = opener;
    this.#readLabel = readLabel;
  }

  async read(portion: StoredPortion): Promise<PortionReading> {
    const { content } = portion;
    if (content === null) {
      return { status: 'unavailable' };
    }
    if (content.encoding === 'base64') {
      return { status: 'unencrypted', text: content.text };
    }
    const key = keyOf(portion.id, content.envelope);
    const opened = this.#kept.get(key) ?? (await (this.#opening.get(key) ?? this.#open(key, content.envelope)));
    if (opened.status !== 'opened') {
      return opened;
    }
    const [boundLabel, partLabel] = await Promise.all([this.#labelOf(opened.boundLabelXml), this.#labelOf(portion.partLabelXml)]);
    return { status: 'opened', text: opened.text, boundLabel, partLabel };
  }

  // Forgets the texts of portions the document no longer holds.
  retain(portions: StoredPortion[]): void {
    const current = new Set(portions.flatMap((portion) => (portion.content?.encoding === 'ztdf' ? [keyOf(portion.id, portion.content.envelope)] : [])));
    for (const key of this.#kept.keys()) {
      if (!current.has(key)) {
        this.#kept.delete(key);
      }
    }
  }

  async #open(key: string, envelope: string): Promise<OpenedEnvelope> {
    const opening = this.#openStored(envelope);
    this.#opening.set(key, opening);
    try {
      const opened = await opening;
      if (opened.status !== 'failed' || !opened.retry) {
        this.#kept.set(key, opened);
      }
      return opened;
    } finally {
      this.#opening.delete(key);
    }
  }

  async #openStored(envelope: string): Promise<OpenedEnvelope> {
    const bytes = envelopeBytes(envelope);
    return bytes === null ? { status: 'failed', reason: messages.envelopeDamaged, retry: false } : this.#opener.open(bytes);
  }

  async #labelOf(xml: string | null): Promise<LabelReading> {
    if (xml === null) {
      return { status: 'invalid' };
    }
    const known = this.#labels.get(xml);
    if (known !== undefined) {
      return known;
    }
    try {
      const label = await this.#readLabel(xml);
      const reading: LabelReading = label === null ? { status: 'invalid' } : { status: 'read', label };
      this.#labels.set(xml, reading);
      return reading;
    } catch (error: unknown) {
      logProblem('Reading a label', error);
      return { status: 'unchecked' };
    }
  }
}

function keyOf(portionId: string, envelope: string): string {
  return `${portionId}:${envelope}`;
}
