import type { FastifyBaseLogger } from 'fastify';
import type { UserIdentity } from './auth/sessions.ts';
import type { DocumentAccessCheck } from './document-access.ts';
import { DocumentQueues } from './document-queues.ts';
import type { StoredDocument } from './documents.ts';
import { type Journal, type JournalPerson, type JournalRole, journalPersonById } from './journal.ts';
import { type CommandService, dropFromSession, requestSession } from './onlyoffice.ts';

// How long new editor configurations wait for the last save of a session the
// portal ended, before they are signed anyway.
const RETIRING_TIMEOUT_MS = 30_000;

// What leads the portal to end a document's session: a new base label, or a
// clearance change that lets someone read less.
export type SessionEndCause = 'base-label' | 'revocation';

const ENDED_SESSION_MESSAGES: Readonly<Record<SessionEndCause, string>> = {
  'base-label': 'Ended an editing session that the base label excludes someone from',
  revocation: 'Ended an editing session that a revocation excludes someone from',
};

// The portal's documents, as the editing sessions need them: a document as
// it is stored now, and its move to a new key; null when the document is
// gone or, for a move, no longer under `fromKey`.
export interface SessionDocuments {
  find: (documentId: string) => Promise<StoredDocument | null>;
  moveToNewKey: (documentId: string, fromKey: string) => Promise<StoredDocument | null>;
}

// The Document Server's editing sessions outlive the decisions that let
// people in: a signed editor configuration joins its document's session
// whenever it connects, and reconnects after any interruption. The portal
// therefore decides again for whoever joins a session as an editor, and ends
// the session of a document whose base label now excludes someone holding a
// configuration for it, after a new base label or a clearance change that
// lets them read less: the document moves to a new key, and the Document
// Server refuses the configurations that name the old one once its last save
// is stored.
export class EditingSessions {
  #commands: CommandService;
  #documentAccess: DocumentAccessCheck;
  #documents: SessionDocuments;
  #journal: Journal;
  #log: FastifyBaseLogger;
  // Whom each editor user id stands for, as of the last configuration the
  // portal signed for them. Kept in memory: a restart forgets it.
  #identities = new Map<string, UserIdentity>();
  // By key, the document it names and the editor user ids that received a
  // configuration naming it, since the portal started.
  #keys = new Map<string, { documentId: string; holders: Set<string> }>();
  // The key of each document whose session the portal ended and whose last
  // save has not arrived yet.
  #retiring = new Map<string, { key: string; since: number }>();
  // The ends of each document's sessions, one at a time.
  #ends = new DocumentQueues();

  constructor(commands: CommandService, documentAccess: DocumentAccessCheck, documents: SessionDocuments, journal: Journal, log: FastifyBaseLogger) {
    this.#commands = commands;
    this.#documentAccess = documentAccess;
    this.#documents = documents;
    this.#journal = journal;
    this.#log = log;
  }

  // Called whenever the portal signs a configuration, whether to edit or to
  // view: both can join the session of the document's key.
  remember(document: Pick<StoredDocument, 'id' | 'key'>, user: UserIdentity): void {
    this.#identities.set(user.id, user);
    const known = this.#keys.get(document.key) ?? { documentId: document.id, holders: new Set<string>() };
    known.holders.add(user.id);
    this.#keys.set(document.key, known);
  }

  // The people editor user ids stand for, as of the last configuration the
  // portal signed for each, as the journal names them.
  people(role: JournalRole, editorUserIds: string[]): JournalPerson[] {
    return editorUserIds.map((id) => journalPersonById(role, id, this.#identities.get(id) ?? null));
  }

  // The editor user ids that received a configuration naming `key`, to edit
  // or to view, as far as the portal knows since it started.
  holdersOf(key: string): string[] {
    return [...(this.#keys.get(key)?.holders ?? [])];
  }

  // The session of `key` ended with a save: no configuration naming it can
  // join a session any more.
  forget(key: string): void {
    this.#keys.delete(key);
  }

  // Disconnects, from the session of `key`, the editors who joined it and
  // whom the document's stored base label excludes. Someone the portal has
  // no identity for, after a restart for instance, is disconnected too.
  async admit(document: StoredDocument, key: string, editorUserIds: string[]): Promise<void> {
    const refused = await this.#refused(document, editorUserIds);
    if (refused.length === 0) {
      return;
    }
    const dropped = await dropFromSession(this.#commands, key, refused);
    this.#journal.record({
      category: 'session',
      level: 'warn',
      message: 'Disconnected editors whom the base label excludes from an editing session',
      documentId: document.id,
      fields: { users: refused, dropped },
      people: this.people('excluded', refused),
    });
  }

  // Ends the session of `key` when the document's stored base label excludes
  // someone who holds a configuration naming it or who edits in it, or when
  // the portal cannot tell: after a restart, it no longer knows who holds one.
  // The document moves to a new key, and every connection goes, viewers
  // included. With no session open under the key, there is none to end, and
  // a revocation waits for the next check when the Document Server cannot
  // tell. Ends run one at a time per document: a later one finds the document
  // under a new key already, and does nothing.
  async endIfExcluded(documentId: string, key: string, cause: SessionEndCause): Promise<void> {
    await this.#ends.run(documentId, async () => {
      const document = await this.#documents.find(documentId);
      if (document === null || document.key !== key) {
        return;
      }
      const session = await requestSession(this.#commands, key);
      if (session?.open === false || (session === null && cause === 'revocation')) {
        return;
      }
      const holders = this.#keys.get(key)?.holders;
      const editors = session?.editors ?? [];
      const refused = await this.#refused(document, [...new Set([...(holders ?? []), ...editors])]);
      if (holders !== undefined && session !== null && refused.length === 0) {
        return;
      }
      // Only editors send a last save; the Document Server may not have said
      // whether there are any.
      const retiring = session === null || editors.length > 0 ? { key, since: Date.now() } : null;
      if (retiring !== null) {
        this.#retiring.set(documentId, retiring);
      }
      if ((await this.#documents.moveToNewKey(documentId, key)) === null) {
        if (retiring !== null && this.#retiring.get(documentId) === retiring) {
          this.#retiring.delete(documentId);
        }
        return;
      }
      this.forget(key);
      const dropped = await dropFromSession(this.#commands, key, null).catch((error: unknown) => {
        this.#log.error({ documentId, err: error }, 'The connections to an ended editing session could not be dropped');
        return false;
      });
      this.#journal.record({
        category: 'session',
        level: 'warn',
        message: ENDED_SESSION_MESSAGES[cause],
        documentId,
        fields: { excluded: refused, holdersKnown: holders !== undefined, dropped },
        people: this.people('excluded', refused),
      });
    });
  }

  // Ends the sessions of the documents whose stored base label no longer
  // lets in the person with the email address `email`, where they hold a
  // configuration, as `endIfExcluded` does: a clearance change that lets them
  // read less applies at once, and one that lets them read more ends nothing.
  // Only a refusal for their clearance counts: a decision the policy service
  // could not make ends nothing here. A failure on one document leaves the
  // others checked.
  async applyClearanceChange(email: string): Promise<void> {
    const editorUserIds = [...this.#identities].filter(([, identity]) => sameEmailAddress(identity.email, email)).map(([id]) => id);
    await Promise.all(
      [...this.#keys].map(async ([key, { documentId, holders }]) => {
        const heldBy = editorUserIds.filter((id) => holders.has(id));
        if (heldBy.length === 0) {
          return;
        }
        try {
          const document = await this.#documents.find(documentId);
          // A document that moved to a new key since has no session under this one.
          if (document !== null && document.key === key && (await this.#refusedForClearance(document, heldBy))) {
            await this.endIfExcluded(document.id, key, 'revocation');
          }
        } catch (error: unknown) {
          this.#log.error({ documentId, err: error }, 'An editing session could not be checked after a clearance change');
        }
      }),
    );
  }

  // While true, the document's ended session may still send its last save,
  // which a newer session must not start without.
  isRetiring(documentId: string): boolean {
    const retiring = this.#retiring.get(documentId);
    if (retiring !== undefined && Date.now() - retiring.since > RETIRING_TIMEOUT_MS) {
      this.#retiring.delete(documentId);
      this.#log.warn({ documentId, key: retiring.key }, 'The last save of an ended editing session never came');
      return false;
    }
    return retiring !== undefined;
  }

  // The key of the document's ended session, whose last save is still
  // welcome; null when there is none.
  retiringKey(documentId: string): string | null {
    return this.isRetiring(documentId) ? (this.#retiring.get(documentId)?.key ?? null) : null;
  }

  retired(documentId: string): void {
    this.#retiring.delete(documentId);
  }

  async #refused(document: StoredDocument, editorUserIds: string[]): Promise<string[]> {
    const decisions = await Promise.all(
      editorUserIds.map(async (id) => {
        const identity = this.#identities.get(id);
        return identity === undefined ? false : (await this.#documentAccess.decideOne(identity, document)).open;
      }),
    );
    return editorUserIds.filter((_id, index) => decisions[index] !== true);
  }

  // Whether the stored base label refuses one of these people for their
  // clearance, as the policy service decides.
  async #refusedForClearance(document: StoredDocument, editorUserIds: string[]): Promise<boolean> {
    const decisions = await Promise.all(
      editorUserIds.map(async (id) => {
        const identity = this.#identities.get(id);
        return identity === undefined ? null : this.#documentAccess.decideOne(identity, document);
      }),
    );
    return decisions.some((decision) => decision?.open === false && decision.reason === 'clearance');
  }
}

// Whether an identity's email address is `email`, whatever the case: the
// clearance directory writes addresses in lowercase.
function sameEmailAddress(address: string | null, email: string): boolean {
  return address !== null && address.toLowerCase() === email.toLowerCase();
}
