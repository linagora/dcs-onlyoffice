import type { FastifyBaseLogger } from 'fastify';
import type { UserIdentity } from './auth/sessions.ts';
import type { DocumentAccessCheck } from './document-access.ts';
import type { StoredDocument } from './documents.ts';
import { type CommandService, dropFromSession, requestSessionEditors } from './onlyoffice.ts';

// How long new editor configurations wait for the last save of a session the
// portal ended, before they are signed anyway.
const RETIRING_TIMEOUT_MS = 30_000;

// The Document Server's editing sessions outlive the decisions that let
// people in: a signed editor configuration joins its document's session
// whenever it connects, and reconnects after any interruption. The portal
// therefore decides again for whoever joins a session as an editor, and ends
// the session of a document whose base label now excludes someone holding a
// configuration for it: the document moves to a new key, and the Document
// Server refuses the configurations that name the old one once its last save
// is stored.
export class EditingSessions {
  #commands: CommandService;
  #documentAccess: DocumentAccessCheck;
  #log: FastifyBaseLogger;
  // Whom each editor user id stands for, as of the last configuration the
  // portal signed for them. Kept in memory: a restart forgets it.
  #identities = new Map<string, UserIdentity>();
  // The editor user ids that received a configuration naming each key, since
  // the portal started.
  #holders = new Map<string, Set<string>>();
  // The key of each document whose session the portal ended and whose last
  // save has not arrived yet.
  #retiring = new Map<string, { key: string; since: number }>();

  constructor(commands: CommandService, documentAccess: DocumentAccessCheck, log: FastifyBaseLogger) {
    this.#commands = commands;
    this.#documentAccess = documentAccess;
    this.#log = log;
  }

  // Called whenever the portal signs a configuration, whether to edit or to
  // view: both can join the session of its key.
  remember(key: string, user: UserIdentity): void {
    this.#identities.set(user.id, user);
    const holders = this.#holders.get(key) ?? new Set<string>();
    holders.add(user.id);
    this.#holders.set(key, holders);
  }

  // The session of `key` ended with a save: no configuration naming it can
  // join a session any more.
  forget(key: string): void {
    this.#holders.delete(key);
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
    this.#log.warn({ documentId: document.id, users: refused, dropped }, 'Disconnected editors whom the base label excludes from an editing session');
  }

  // Ends the session of `key` when the document's stored base label excludes
  // someone who holds a configuration naming it or who edits in it, or when
  // the portal cannot tell: after a restart, it no longer knows who holds one.
  async endIfExcluded(document: StoredDocument, key: string, moveToNewKey: () => Promise<StoredDocument | null>): Promise<void> {
    const holders = this.#holders.get(key);
    const editors = await requestSessionEditors(this.#commands, key);
    const refused = await this.#refused(document, [...new Set([...(holders ?? []), ...(editors ?? [])])]);
    if (holders !== undefined && editors !== null && refused.length === 0) {
      return;
    }
    this.#retiring.set(document.id, { key, since: Date.now() });
    if ((await moveToNewKey()) === null) {
      this.#retiring.delete(document.id);
      return;
    }
    this.forget(key);
    const dropped = await dropFromSession(this.#commands, key, null);
    this.#log.warn(
      { documentId: document.id, excluded: refused, holdersKnown: holders !== undefined, dropped },
      'Ended an editing session that the base label excludes someone from',
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
}
