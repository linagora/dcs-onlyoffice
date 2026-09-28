import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildPolicyServer } from '../src/server.ts';
import { MemoryClearanceStore } from './clearance-store.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_SEEDS = path.join(import.meta.dirname, '..', '..', 'deploy', 'directory', 'seeds');
const LEASE_MS = 20_000;
const START = new Date('2026-09-28T10:00:00.000Z');

// Codes of the demo SPIF's labels, as the portion tags carry them.
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DEMO-FR:2/1.1';

// The demo seed's people, as the portal's relay names them.
const ALICE = { id: 'alice', name: 'Alice Martin', email: 'alice.martin@dcs.test' };
const BOB = { id: 'bob', name: 'Bob Walker', email: 'bob.walker@dcs.test' };
type Person = typeof ALICE;

function identity(person: Person): Record<string, string> {
  return {
    'x-user-id': encodeURIComponent(person.id),
    'x-user-name': encodeURIComponent(person.name),
    'x-user-email': encodeURIComponent(person.email),
  };
}

describe('portion locks', () => {
  let server: FastifyInstance;
  let clock = START;
  let documentId = '';
  let documents = 0;

  const lock = async (person: Person, portion: string, code: string, renewal = false) =>
    server.inject({
      method: 'POST',
      url: `/documents/${documentId}/portions/${portion}/lock`,
      headers: identity(person),
      payload: { code, renewal },
    });
  const release = async (person: Person, portion: string, version: number | null = null) =>
    server.inject({
      method: 'POST',
      url: `/documents/${documentId}/portions/${portion}/lock/release`,
      headers: identity(person),
      payload: version === null ? {} : { version },
    });
  const listed = async (person: Person): Promise<unknown> =>
    (await server.inject({ method: 'GET', url: `/documents/${documentId}/locks`, headers: identity(person) })).json();
  const advance = (milliseconds: number): void => {
    clock = new Date(clock.getTime() + milliseconds);
  };

  before(async () => {
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      clearanceDirectory: { store: new MemoryClearanceStore(), seedFolder: DEMO_SEEDS },
      portionLockLeaseMs: LEASE_MS,
      now: () => clock,
    });
  });
  after(async () => {
    await server.close();
  });
  // Each test works on a document of its own, from the same instant.
  beforeEach(() => {
    documents += 1;
    documentId = `exercise-${documents}`;
    clock = START;
  });

  it('gives a free lock to an author whose clearance allows the portion label, for the lease', async () => {
    const response = await lock(ALICE, 'p-1', SPECIAL_FRANCE);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      portion: 'p-1',
      holder: { id: 'alice', name: 'Alice Martin' },
      expiresAt: '2026-09-28T10:00:20.000Z',
      leaseMs: 20_000,
      version: null,
    });
  });

  it('refuses a held lock to another author, naming its holder', async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    const response = await lock(BOB, 'p-1', DIFFUSION_RESTREINTE);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { holder: { id: 'alice', name: 'Alice Martin' } });
  });

  it('renews the lock its holder still holds, and not one that lapsed', async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    advance(19_000);
    const renewed = await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE, true);
    assert.equal(renewed.statusCode, 200);
    assert.equal((renewed.json() as { expiresAt: string }).expiresAt, '2026-09-28T10:00:39.000Z'); // SAFETY: the answer asserted just above
    advance(20_001);
    const lapsed = await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE, true);
    assert.equal(lapsed.statusCode, 409);
    assert.deepEqual(lapsed.json(), { holder: null });
  });

  it('frees a released lock for the next author, and releases only for its holder', async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    assert.equal((await release(BOB, 'p-1')).statusCode, 409);
    assert.equal((await release(ALICE, 'p-1')).statusCode, 204);
    assert.equal((await lock(BOB, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
  });

  it('tells the next author the version the last change wrote', async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    assert.equal((await release(ALICE, 'p-1', 2)).statusCode, 204);
    const response = await lock(BOB, 'p-1', DIFFUSION_RESTREINTE);
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { version: number | null }).version, 2); // SAFETY: the answer asserted just above
  });

  it('lets a lock lapse once its lease ends', async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    advance(20_001);
    assert.equal((await lock(BOB, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
  });

  it('refuses a lock to an author whose clearance does not allow the portion label', async () => {
    const response = await lock(BOB, 'p-1', SPECIAL_FRANCE);
    assert.equal(response.statusCode, 403);
    assert.deepEqual(await listed(BOB), []);
  });

  it("lists a document's current locks, not the lapsed ones nor another document's", async () => {
    assert.equal((await lock(ALICE, 'p-1', DIFFUSION_RESTREINTE)).statusCode, 200);
    advance(10_000);
    assert.equal((await lock(BOB, 'p-2', DIFFUSION_RESTREINTE)).statusCode, 200);
    advance(10_001);
    assert.deepEqual(await listed(ALICE), [{ portion: 'p-2', holder: { id: 'bob', name: 'Bob Walker' }, expiresAt: '2026-09-28T10:00:30.000Z' }]);
    documentId = 'another-document';
    assert.deepEqual(await listed(ALICE), []);
  });

  it('refuses a caller without an identity, and a label the policy does not know', async () => {
    const anonymous = await server.inject({
      method: 'POST',
      url: `/documents/${documentId}/portions/p-1/lock`,
      payload: { code: DIFFUSION_RESTREINTE },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal((await lock(ALICE, 'p-1', 'DEMO-FR:not-a-label')).statusCode, 422);
  });
});
