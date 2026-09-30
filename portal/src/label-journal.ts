import type { FastifyBaseLogger } from 'fastify';
import type { UserIdentity } from './auth/sessions.ts';
import type { CarriedLabel, UploadReading } from './binding-signature.ts';
import type { FileLabels } from './document-labels.ts';
import { type Journal, type JournalCategory, type JournalPerson, journalPerson } from './journal.ts';

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

// A protected portion the panel deleted, with its last label and version.
export interface PortionDeletion {
  documentId: string;
  portion: string;
  before: PortionState;
}

// Content already in a document that the panel protected as a new portion,
// with its label and version: that content went through ONLYOFFICE in clear
// before, as its author was warned.
export interface ExistingContentProtection {
  documentId: string;
  portion: string;
  after: PortionState;
}

// A DOCX a person brought into the portal as a new document: the base label
// it got, the label the file carried, as a base label, and where that came
// from, null for none, and whether the file's binding signature matched.
export interface DocumentUpload {
  documentId: string;
  base: string;
  read: CarriedLabel | null;
  signature: UploadReading['signature'];
}

// The label changes of the journal. Any editor can change a label in the
// file, and the panel offers lower ones only to administrators: the portal
// records every lowering. The panel reports its own changes, deletions and
// protections of existing content, with the person who made them; a save
// that lowers a label or removes a portion is recorded too, with the people
// of its editing session, whatever made the change. Removing the base label
// counts as lowering it.
export class LabelJournal {
  #policyUrl: string;
  #journal: Journal;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, journal: Journal, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#journal = journal;
    this.#log = log;
  }

  async recordBaseLabelReport(change: BaseLabelChange, author: UserIdentity): Promise<void> {
    const lowering = await this.#lowering(change.before, change.after);
    this.#recordReport('label', change, author, lowering, { changed: 'Base label changed in the panel', lowered: 'Base label lowered in the panel' });
  }

  async recordPortionReport(change: PortionChange, author: UserIdentity): Promise<void> {
    const lowering = await this.#lowering(change.before.label, change.after.label);
    this.#recordReport('label', change, author, lowering, { changed: 'Portion changed in the panel', lowered: 'Portion label lowered in the panel' });
  }

  recordPortionDeletion({ documentId, ...deletion }: PortionDeletion, author: UserIdentity): void {
    this.#recordAuthored('label', 'info', 'Portion deleted in the panel', documentId, { ...deletion, user: author.id }, author);
  }

  recordExistingContentProtection({ documentId, ...protection }: ExistingContentProtection, author: UserIdentity): void {
    this.#recordAuthored('label', 'info', 'Existing content protected in the panel', documentId, { ...protection, user: author.id }, author);
  }

  // An upload is recorded as a change of the label the file carried, which
  // `lowering` tells whether the base label lowers.
  recordUpload(upload: DocumentUpload, lowering: boolean | null, author: UserIdentity): void {
    this.#recordReport('upload', upload, author, lowering, { changed: 'Document uploaded', lowered: 'Document uploaded, its label lowered' });
  }

  // What a save changed in the labels in clear of a stored file: its base
  // label, and the portions it already held, one of which is removed with
  // its placeholder, whatever becomes of its part.
  async recordSave(documentId: string, before: FileLabels, after: FileLabels, session: JournalPerson[]): Promise<void> {
    const sessionUsers = session.map((person) => person.id);
    const baseLowering = await this.#lowering(before.base, after.base);
    this.#recordSaved(documentId, { before: before.base, after: after.base, sessionUsers }, session, baseLowering, 'Base label');
    for (const [portion, previous] of before.portions) {
      const labels = after.portions.get(portion) ?? { part: null, tag: null };
      if (previous.tag !== null && labels.tag === null) {
        this.#journal.record({
          category: 'save',
          level: 'warn',
          message: 'Portion removed',
          documentId,
          fields: { portion, before: previous, after: labels, sessionUsers },
          people: session,
        });
      } else if (after.portions.has(portion)) {
        const lowerings = await Promise.all([this.#lowering(previous.part, labels.part), this.#lowering(previous.tag, labels.tag)]);
        const lowering = lowerings.includes(true) ? true : lowerings.includes(null) ? null : false;
        this.#recordSaved(documentId, { portion, before: previous, after: labels, sessionUsers }, session, lowering, 'Portion label');
      }
    }
  }

  // Every change the panel reports is recorded.
  #recordReport(
    category: JournalCategory,
    { documentId, ...change }: { documentId: string },
    author: UserIdentity,
    lowering: boolean | null,
    messages: { changed: string; lowered: string },
  ): void {
    const message = lowering === null ? `${messages.changed}, and whether it was lowered is unknown` : lowering ? messages.lowered : messages.changed;
    this.#recordAuthored(category, lowering === null ? 'warn' : 'info', message, documentId, { ...change, user: author.id, lowering }, author);
  }

  // An entry that names the person who acted.
  #recordAuthored(
    category: JournalCategory,
    level: 'info' | 'warn',
    message: string,
    documentId: string,
    fields: Record<string, unknown>,
    author: UserIdentity,
  ): void {
    this.#journal.record({ category, level, message, documentId, fields, people: [journalPerson('author', author)] });
  }

  // Only lowerings, and labels that may be lowered, are recorded.
  #recordSaved(
    documentId: string,
    fields: Record<string, unknown>,
    session: JournalPerson[],
    lowering: boolean | null,
    subject: 'Base label' | 'Portion label',
  ): void {
    if (lowering !== false) {
      const message = lowering === true ? `${subject} lowered` : `${subject} changed, and whether it was lowered is unknown`;
      this.#journal.record({ category: 'save', level: 'warn', message, documentId, fields, people: session });
    }
  }

  async #lowering(before: string | null, after: string | null): Promise<boolean | null> {
    return isLowering(this.#policyUrl, before, after, this.#log);
  }
}

// Whether a label replaces a more restrictive one, by the rules of its
// security policy; removing a label lowers it. Null when the policy service
// cannot tell.
export async function isLowering(policyInternalUrl: string, before: string | null, after: string | null, log: FastifyBaseLogger): Promise<boolean | null> {
  if (before === null || before === after) {
    return false;
  }
  if (after === null) {
    return true;
  }
  try {
    const response = await fetch(new URL('/labels/lowering', policyInternalUrl), {
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
    log.error({ before, after, err: error }, 'The policy service could not tell whether a label is lowered');
    return null;
  }
}
