import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Clearance } from '../src/directory/clearance.ts';
import type { ClearanceStore } from '../src/directory/store.ts';
import { buildPolicyServer } from '../src/server.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_SEEDS = path.join(import.meta.dirname, '..', '..', 'deploy', 'directory', 'seeds');

// Stands for PostgreSQL: remembers what the service adds, and finds it again.
class RecordingStore implements ClearanceStore {
  #added: Clearance[] = [];

  get added(): Clearance[] {
    return this.#added;
  }

  async prepare(): Promise<void> {}

  async addMissing(clearances: Clearance[]): Promise<number> {
    this.#added.push(...clearances);
    return clearances.length;
  }

  async clearanceOf(email: string, policy: string): Promise<Clearance | null> {
    return this.#added.find((clearance) => clearance.email === email && clearance.policy === policy) ?? null;
  }

  async list(): Promise<Clearance[]> {
    return [...this.#added];
  }

  async update(clearance: Clearance): Promise<boolean> {
    const index = this.#added.findIndex((entry) => entry.email === clearance.email && entry.policy === clearance.policy);
    if (index === -1) {
      return false;
    }
    this.#added[index] = clearance;
    return true;
  }

  async close(): Promise<void> {}
}

async function seedFolder(clearances: unknown[]): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'dcs-seed-'));
  await writeFile(path.join(folder, 'seed.json'), JSON.stringify({ clearances }));
  return folder;
}

async function seededClearances(folder: string): Promise<Clearance[]> {
  const store = new RecordingStore();
  const server = await buildPolicyServer({ spifDirectory: DEMO_SPIFS, clearanceDirectory: { store, seedFolder: folder } });
  await server.close();
  return store.added;
}

// Names written in another case than the SPIF's.
const REQUEST = {
  email: 'Someone@Example.org',
  name: 'Someone',
  nationality: 'FRA',
  policy: 'demo-fr',
  classification: 'diffusion restreinte',
  categories: ['special handling:special france', 'releasable to:nato'],
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: '2027-01-01T00:00:00Z',
};

describe('clearance directory seeding', () => {
  it("adds the demo seed's clearances", async () => {
    const clearances = await seededClearances(DEMO_SEEDS);

    assert.deepEqual(
      clearances.map((clearance) => [clearance.email, clearance.classification, clearance.categories.map((held) => `${held.tagSet}/${held.name}`)]),
      [
        ['alice.martin@dcs.test', 'DIFFUSION RESTREINTE', ['Special Handling/SPECIAL FRANCE', 'Releasable To/NATO']],
        ['bob.walker@dcs.test', 'DIFFUSION RESTREINTE', ['Releasable To/NATO']],
        ['chloe.bernard@dcs.test', 'NON PROTEGE', []],
        ['erin.petit@dcs.test', 'DIFFUSION RESTREINTE', ['Special Handling/SPECIAL FRANCE', 'Releasable To/NATO']],
      ],
    );
  });

  it('spells every name as the SPIF does, and the email address in lower case', async () => {
    const [clearance] = await seededClearances(await seedFolder([REQUEST]));

    assert.deepEqual(clearance, {
      email: 'someone@example.org',
      name: 'Someone',
      nationality: 'FRA',
      policy: 'DEMO-FR',
      classification: 'DIFFUSION RESTREINTE',
      categories: [
        { tagSet: 'Special Handling', name: 'SPECIAL FRANCE' },
        { tagSet: 'Releasable To', name: 'NATO' },
      ],
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2027-01-01T00:00:00Z'),
    });
  });

  const refusals: [string, unknown, RegExp][] = [
    ['an unknown classification', { ...REQUEST, classification: 'SECRET' }, /has no classification SECRET/],
    ['an unknown category', { ...REQUEST, categories: ['Releasable To:FVEY'] }, /has no category Releasable To:FVEY/],
    ['an informative category', { ...REQUEST, categories: ['Composition:MORE RESTRICTIVE PORTIONS'] }, /grants no access/],
    ['a validity period that ends before it starts', { ...REQUEST, validFrom: '2027-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' }, /ends before it starts/],
    ['a malformed email address', { ...REQUEST, email: 'someone' }, /not an email address/],
    ['an incomplete entry', { email: 'someone@example.org' }, /clearance 1 is incomplete/],
  ];
  for (const [what, entry, error] of refusals) {
    it(`refuses to start on a seed with ${what}`, async () => {
      await assert.rejects(seededClearances(await seedFolder([entry])), error);
    });
  }
});

// The demo seed's clearances (deploy/directory/seeds/demo.json), on a day when
// erin's has ended; the codes are those of the demo SPIF's labels.
describe('labels a clearance allows', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      clearanceDirectory: { store: new RecordingStore(), seedFolder: DEMO_SEEDS },
      now: (): Date => new Date('2026-09-26T12:00:00Z'),
    });
  });
  after(async () => {
    await server.close();
  });

  // The portal relay sends the caller's email address URI-encoded.
  async function allowedCodes(email: string | null): Promise<string[]> {
    const headers = email === null ? {} : { 'x-user-email': encodeURIComponent(email) };
    const response = await server.inject({ method: 'GET', url: '/policies/DEMO-FR/labels/allowed', headers });
    assert.equal(response.statusCode, 200);
    const labels: unknown = response.json();
    assert.ok(Array.isArray(labels), 'expected a label list');
    return labels.map((label: unknown) => (typeof label === 'object' && label !== null && 'code' in label ? String(label.code) : ''));
  }

  it('offers every label to a clearance that allows them all', async () => {
    assert.deepEqual(await allowedCodes('alice.martin@dcs.test'), ['DEMO-FR:1', 'DEMO-FR:2', 'DEMO-FR:2/1.1', 'DEMO-FR:2/2.1']);
  });

  it('leaves out the labels whose categories the clearance does not hold', async () => {
    assert.deepEqual(await allowedCodes('bob.walker@dcs.test'), ['DEMO-FR:1', 'DEMO-FR:2', 'DEMO-FR:2/2.1']);
  });

  it('leaves out the classifications above the clearance', async () => {
    assert.deepEqual(await allowedCodes('chloe.bernard@dcs.test'), ['DEMO-FR:1']);
  });

  it('finds the directory entry whatever the case of the email address', async () => {
    assert.deepEqual(await allowedCodes('Chloe.Bernard@DCS.test'), ['DEMO-FR:1']);
  });

  it('offers nothing without a clearance, outside its validity period, or without an email address', async () => {
    assert.deepEqual(await allowedCodes('dan.moreau@dcs.test'), []);
    assert.deepEqual(await allowedCodes('erin.petit@dcs.test'), []);
    assert.deepEqual(await allowedCodes(null), []);
  });
});

describe('clearance directory administration', () => {
  let server: FastifyInstance;
  const SECRET = 'fictional-administration-secret';
  const admin = { authorization: `Bearer ${SECRET}` };
  before(async () => {
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      clearanceDirectory: { store: new RecordingStore(), seedFolder: DEMO_SEEDS },
      directoryAdministrationSecret: SECRET,
    });
  });
  after(async () => {
    await server.close();
  });

  const bobUrl = `/directory/policies/DEMO-FR/clearances/${encodeURIComponent('bob.walker@dcs.test')}`;

  it('lists every entry, as the directory writes it', async () => {
    const response = await server.inject({ method: 'GET', url: '/directory/clearances', headers: admin });

    assert.equal(response.statusCode, 200);
    const body: unknown = response.json();
    const clearances: unknown[] = typeof body === 'object' && body !== null && 'clearances' in body && Array.isArray(body.clearances) ? body.clearances : [];
    assert.deepEqual(
      clearances.map((clearance) => (typeof clearance === 'object' && clearance !== null && 'email' in clearance ? clearance.email : null)),
      ['alice.martin@dcs.test', 'bob.walker@dcs.test', 'chloe.bernard@dcs.test', 'erin.petit@dcs.test'],
    );
    assert.deepEqual(clearances[1], {
      email: 'bob.walker@dcs.test',
      name: 'Bob Walker',
      nationality: 'GBR',
      policy: 'DEMO-FR',
      classification: 'DIFFUSION RESTREINTE',
      categories: ['Releasable To:NATO'],
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2036-01-01T00:00:00.000Z',
    });
  });

  it('offers what a clearance under a policy can hold', async () => {
    const response = await server.inject({ method: 'GET', url: '/policies/DEMO-FR/clearance-choices' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      classifications: ['NON PROTEGE', 'DIFFUSION RESTREINTE'],
      categories: ['Special Handling:SPECIAL FRANCE', 'Releasable To:NATO'],
    });
  });

  it('changes the terms of an entry, and keeps who it belongs to', async () => {
    const terms = {
      classification: 'diffusion restreinte',
      categories: ['Releasable To:NATO', 'Special Handling:SPECIAL FRANCE'],
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2030-01-01T00:00:00Z',
    };

    const response = await server.inject({ method: 'PUT', url: bobUrl, headers: admin, payload: terms });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      email: 'bob.walker@dcs.test',
      name: 'Bob Walker',
      nationality: 'GBR',
      policy: 'DEMO-FR',
      classification: 'DIFFUSION RESTREINTE',
      categories: ['Releasable To:NATO', 'Special Handling:SPECIAL FRANCE'],
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
    });
  });

  const period = { validFrom: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' };
  const refusals: [string, Record<string, unknown>, number, string | null][] = [
    ['an informative category', { classification: 'DIFFUSION RESTREINTE', categories: ['Composition:MORE RESTRICTIVE PORTIONS'], ...period }, 422,
      'bob.walker@dcs.test: the informative category Composition:MORE RESTRICTIVE PORTIONS grants no access'],
    ['an unknown classification', { classification: 'TRES SECRET', categories: [], ...period }, 422, 'bob.walker@dcs.test: DEMO-FR has no classification TRES SECRET'],
    ['an unknown category', { classification: 'NON PROTEGE', categories: ['Releasable To:MARS'], ...period }, 422, 'bob.walker@dcs.test: DEMO-FR has no category Releasable To:MARS'],
    ['a period that ends before it starts', { classification: 'NON PROTEGE', categories: [], validFrom: '2030-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' }, 422,
      'bob.walker@dcs.test: the validity period ends before it starts'],
    ['a malformed request', { classification: 'NON PROTEGE', categories: 'Releasable To:NATO', ...period }, 400, null],
  ];
  for (const [what, terms, statusCode, error] of refusals) {
    it(`refuses ${what}, and leaves the entry as it was`, async () => {
      const response = await server.inject({ method: 'PUT', url: bobUrl, headers: admin, payload: terms });

      assert.equal(response.statusCode, statusCode);
      if (error !== null) {
        assert.deepEqual(response.json(), { error });
      }
    });
  }

  it('refuses to change an entry the directory does not hold', async () => {
    const terms = { classification: 'NON PROTEGE', categories: [], validFrom: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' };
    const url = `/directory/policies/DEMO-FR/clearances/${encodeURIComponent('dan.moreau@dcs.test')}`;

    const response = await server.inject({ method: 'PUT', url, headers: admin, payload: terms });

    assert.equal(response.statusCode, 404);
  });

  it('keeps the directory to the portal, which holds the secret', async () => {
    const terms = { classification: 'NON PROTEGE', categories: [], ...period };
    // Identity headers alone, as any container of the stack could send them.
    const forged = { 'x-user-email': 'alice.martin%40dcs.test', 'x-user-groups': 'dcs-maquette,dcs-maquette-admin' };

    assert.equal((await server.inject({ method: 'GET', url: '/directory/clearances', headers: forged })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PUT', url: bobUrl, headers: forged, payload: terms })).statusCode, 403);
    assert.equal((await server.inject({ method: 'PUT', url: bobUrl, headers: { authorization: 'Bearer another-secret' }, payload: terms })).statusCode, 403);
  });
});
