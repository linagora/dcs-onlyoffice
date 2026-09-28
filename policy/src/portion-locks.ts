import type { FastifyInstance, FastifyRequest } from 'fastify';
import { callerIdentity, type CallerIdentity } from './caller.ts';
import { readField, readTextField } from './guards.ts';

export interface PortionLock {
  portion: string;
  holder: CallerIdentity;
  expiresAt: Date;
}

type LockAttempt = { status: 'held'; lock: PortionLock } | { status: 'taken'; holder: CallerIdentity | null };

// Who is changing each protected portion: one author at a time, until they
// release it or stop renewing it. Locks live in memory, so a restart of the
// service frees them all. The service also remembers the last portion version
// a released lock reported, so that an author whose editor has not received
// that version yet does not change the version before it.
export class PortionLocks {
  #leaseMs: number;
  // By document, then by portion.
  #locks = new Map<string, Map<string, PortionLock>>();
  #versions = new Map<string, Map<string, number>>();

  constructor(leaseMs: number) {
    this.#leaseMs = leaseMs;
  }

  get leaseMs(): number {
    return this.#leaseMs;
  }

  // Taking a free lock, or renewing the one the holder still holds; a renewal
  // fails once the lock has lapsed, since someone else could have changed the
  // portion meanwhile.
  take(document: string, portion: string, holder: CallerIdentity, renewal: boolean, now: Date): LockAttempt {
    const current = this.#current(document, portion, now);
    if (current !== null && current.holder.id !== holder.id) {
      return { status: 'taken', holder: current.holder };
    }
    if (renewal && current === null) {
      return { status: 'taken', holder: null };
    }
    const lock = { portion, holder, expiresAt: new Date(now.getTime() + this.#leaseMs) };
    entriesOf(this.#locks, document).set(portion, lock);
    return { status: 'held', lock };
  }

  // False when someone else holds the lock. A release after a change reports
  // the version the change wrote.
  release(document: string, portion: string, holderId: string, version: number | null, now: Date): boolean {
    const current = this.#current(document, portion, now);
    if (current !== null && current.holder.id !== holderId) {
      return false;
    }
    this.#locks.get(document)?.delete(portion);
    if (version !== null) {
      entriesOf(this.#versions, document).set(portion, version);
    }
    return true;
  }

  // The last version a released lock reported, null when none has.
  versionOf(document: string, portion: string): number | null {
    return this.#versions.get(document)?.get(portion) ?? null;
  }

  list(document: string, now: Date): PortionLock[] {
    return [...(this.#locks.get(document)?.keys() ?? [])]
      .map((portion) => this.#current(document, portion, now))
      .filter((lock): lock is PortionLock => lock !== null);
  }

  #current(document: string, portion: string, now: Date): PortionLock | null {
    const lock = this.#locks.get(document)?.get(portion) ?? null;
    if (lock !== null && lock.expiresAt <= now) {
      this.#locks.get(document)?.delete(portion);
      return null;
    }
    return lock;
  }
}

function entriesOf<T>(maps: Map<string, Map<string, T>>, document: string): Map<string, T> {
  const entries = maps.get(document) ?? new Map<string, T>();
  maps.set(document, entries);
  return entries;
}

// The access decision for the caller's clearance and a label: nobody changes
// what they cannot read. Null when the label is not a valid one.
export type LabelAccessDecision = (request: FastifyRequest, labelCode: string) => Promise<boolean | null>;

interface PortionParams {
  document: string;
  portion: string;
}

export function registerPortionLocks(app: FastifyInstance, locks: PortionLocks, decideAccess: LabelAccessDecision, now: () => Date): void {
  // Takes or, with `renewal`, renews a lock. The label is the one the caller
  // read the portion under: locks coordinate authors, and anyone able to edit
  // the document can write a portion's part without one.
  app.post<{ Params: PortionParams }>('/documents/:document/portions/:portion/lock', async (request, reply) => {
    const holder = callerIdentity(request);
    if (holder === null) {
      return reply.code(401).send({ error: 'The caller is not identified' });
    }
    const code = readTextField(request.body, 'code');
    if (code === null) {
      return reply.code(400).send({ error: 'Expected { code, renewal? }' });
    }
    const granted = await decideAccess(request, code);
    if (granted === null) {
      return reply.code(422).send({ error: `${code} is not a valid label` });
    }
    if (!granted) {
      return reply.code(403).send({ error: 'The clearance does not allow the portion label' });
    }
    const { document, portion } = request.params;
    const attempt = locks.take(document, portion, holder, readField(request.body, 'renewal') === true, now());
    if (attempt.status === 'taken') {
      return reply.code(409).send({ holder: attempt.holder });
    }
    return { ...lockView(attempt.lock), leaseMs: locks.leaseMs, version: locks.versionOf(document, portion) };
  });

  app.post<{ Params: PortionParams }>('/documents/:document/portions/:portion/lock/release', async (request, reply) => {
    const holder = callerIdentity(request);
    if (holder === null) {
      return reply.code(401).send({ error: 'The caller is not identified' });
    }
    const version = readField(request.body, 'version');
    return locks.release(request.params.document, request.params.portion, holder.id, Number.isInteger(version) ? Number(version) : null, now())
      ? reply.code(204).send()
      : reply.code(409).send({ error: 'Someone else holds the lock' });
  });

  app.get<{ Params: { document: string } }>('/documents/:document/locks', async (request) =>
    locks.list(request.params.document, now()).map(lockView),
  );
}

function lockView(lock: PortionLock): { portion: string; holder: CallerIdentity; expiresAt: string } {
  return { portion: lock.portion, holder: lock.holder, expiresAt: lock.expiresAt.toISOString() };
}
