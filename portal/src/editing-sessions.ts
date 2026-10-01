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
  // The periodic check under way, if any.
  #checking: Promise<void> | null = null;
  // The ends of each document's sessions, one at a time.
  #ends = new DocumentQueues();
  // By key, the document of each session the portal ended but whose
  // connections it could not drop: each periodic check tries again, until
  // they are dropped or the session's last save shows that everyone left.
  #undropped = new Map<string, string>();

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
      const dropped = await this.#drop(documentId, key);
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
  // configuration: a clearance change that lets them read less applies at
  // once, and one that lets them read more ends nothing.
  async applyClearanceChange(email: string): Promise<void> {
    const editorUserIds = new Set([...this.#identities].filter(([, identity]) => sameEmailAddress(identity.email, email)).map(([id]) => id));
    await this.#endExcludedSessions(editorUserIds);
  }

  // Checks every session the portal knows of against the current clearances
  // of the people who hold its configurations, as a clearance change made on
  // the administration page does for its holder: an expiry, or a change made
  // in the clearance directory itself, applies at the next check. A check
  // still under way is not started again.
  async checkClearances(): Promise<void> {
    this.#checking ??= this.#checkEverySession();
    return this.#checking;
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
    for (const [key, undroppedDocumentId] of this.#undropped) {
      if (undroppedDocumentId === documentId) {
        this.#undropped.delete(key);
      }
    }
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

  async #checkEverySession(): Promise<void> {
    try {
      await Promise.all([...this.#undropped].map(async ([key, documentId]) => this.#drop(documentId, key)));
      await this.#endExcludedSessions(null);
    } finally {
      this.#checking = null;
    }
  }

  // Drops every connection to the session of `key`, and remembers a failure
  // for the next periodic check.
  async #drop(documentId: string, key: string): Promise<boolean> {
    const dropped = await dropFromSession(this.#commands, key, null).catch((error: unknown) => {
      this.#log.error({ documentId, err: error }, 'The connections to an ended editing session could not be dropped');
      return false;
    });
    if (dropped) {
      this.#undropped.delete(key);
    } else {
      this.#undropped.set(key, documentId);
    }
    return dropped;
  }

  // Ends, as `endIfExcluded` does, the sessions whose document's stored base
  // label refuses, for their clearance, one of their holders among
  // `editorUserIds`, or any of them when it is null. Each person's decisions
  // come in one request; a decision the policy service could not make ends
  // nothing, and a failure leaves the other people and sessions checked.
  async #endExcludedSessions(editorUserIds: ReadonlySet<string> | null): Promise<void> {
    // The documents each of those people holds a configuration of, as they
    // are stored now: one that moved to a new key since has no session under
    // the earlier one.
    const documentsOf = new Map<string, StoredDocument[]>();
    await Promise.all(
      [...this.#keys].map(async ([key, { documentId, holders }]) => {
        const picked = [...holders].filter((id) => editorUserIds === null || editorUserIds.has(id));
        if (picked.length === 0) {
          return;
        }
        const document = await this.#documents.find(documentId).catch((error: unknown) => {
          this.#log.error({ documentId, err: error }, 'A document could not be read to check its editing session');
          return null;
        });
        if (document === null || document.key !== key) {
          return;
        }
        for (const id of picked) {
          documentsOf.set(id, [...(documentsOf.get(id) ?? []), document]);
        }
      }),
    );
    // By key, the documents whose stored base label refuses one of them.
    const excluding = new Map<string, StoredDocument>();
    await Promise.all(
      [...documentsOf].map(async ([id, documents]) => {
        const identity = this.#identities.get(id);
        if (identity === undefined) {
          return;
        }
        try {
          const decisions = await this.#documentAccess.decide(identity, documents);
          documents.forEach((document, index) => {
            const decision = decisions[index];
            if (decision !== undefined && !decision.open && decision.reason === 'clearance') {
              excluding.set(document.key, document);
            }
          });
        } catch (error: unknown) {
          this.#log.error({ editorUserId: id, err: error }, 'The clearance of someone holding an editor configuration could not be checked');
        }
      }),
    );
    await Promise.all(
      [...excluding.values()].map(async (document) =>
        this.endIfExcluded(document.id, document.key, 'revocation').catch((error: unknown) => {
          this.#log.error({ documentId: document.id, err: error }, 'An editing session could not be ended after a revocation');
        }),
      ),
    );
  }
}

// Whether an identity's email address is `email`, whatever the case: the
// clearance directory writes addresses in lowercase.
function sameEmailAddress(address: string | null, email: string): boolean {
  return address !== null && address.toLowerCase() === email.toLowerCase();
}
