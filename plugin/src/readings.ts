import type { EnvelopeOpener, OpenedEnvelope } from './envelopes.ts';
import { messages } from './messages.ts';
import { envelopeBytes, type StoredPortion } from './portions.ts';

// What the panel can show of a portion.
export type PortionReading = OpenedEnvelope | { status: 'unencrypted'; text: string | null } | { status: 'unavailable' };

// Opens each envelope once while the panel is open. What cannot change is
// kept, keyed by the envelope itself so that a changed envelope is opened
// again: a text, a refusal, a damaged envelope. A failure worth retrying is
// not kept, so a later reading retries it.
export class PortionReader {
  #opener: EnvelopeOpener;
  #kept = new Map<string, OpenedEnvelope>();
  #opening = new Map<string, Promise<OpenedEnvelope>>();

  constructor(opener: EnvelopeOpener) {
    this.#opener = opener;
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
    return this.#kept.get(key) ?? (await (this.#opening.get(key) ?? this.#open(key, content.envelope)));
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
}

function keyOf(portionId: string, envelope: string): string {
  return `${portionId}:${envelope}`;
}
