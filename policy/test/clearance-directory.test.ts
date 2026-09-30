import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Clearance } from '../src/directory/clearance.ts';
import { buildPolicyServer } from '../src/server.ts';
import { MemoryClearanceStore } from './clearance-store.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_SEEDS = path.join(import.meta.dirname, '..', '..', 'deploy', 'directory', 'seeds');

async function seedFolder(clearances: unknown[]): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'dcs-seed-'));
  await writeFile(path.join(folder, 'seed.json'), JSON.stringify({ clearances }));
  return folder;
}

async function seededClearances(folder: string): Promise<Clearance[]> {
  const store = new MemoryClearanceStore();
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
      clearanceDirectory: { store: new MemoryClearanceStore(), seedFolder: DEMO_SEEDS },
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

// Anyone may raise a document's base label or a portion's label. Lowering
// one, which shows what it covers to more readers, is reserved to
// administrators whose clearance allows the current label.
describe('labels a caller may give a document or a portion', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      clearanceDirectory: { store: new MemoryClearanceStore(), seedFolder: DEMO_SEEDS },
      now: (): Date => new Date('2026-09-26T12:00:00Z'),
    });
  });
  after(async () => {
    await server.close();
  });

  const EVERY_LABEL = ['DEMO-FR:1', 'DEMO-FR:2', 'DEMO-FR:2/1.1', 'DEMO-FR:2/2.1'];

  // The codes of the labels a route offers the caller instead of `current`.
  async function choices(route: 'base-choices' | 'portion-choices', current: string | null, email: string, groups: string[]): Promise<string[]> {
    const headers = { 'x-user-email': encodeURIComponent(email), 'x-user-groups': groups.map(encodeURIComponent).join(',') };
    const query = current === null ? '' : `?current=${encodeURIComponent(current)}`;
    const response = await server.inject({ method: 'GET', url: `/policies/DEMO-FR/labels/${route}${query}`, headers });
    assert.equal(response.statusCode, 200);
    const labels: unknown = response.json();
    assert.ok(Array.isArray(labels), 'expected a label list');
    return labels.map((label: unknown) => (typeof label === 'object' && label !== null && 'code' in label ? String(label.code) : ''));
  }

  async function baseChoices(current: string | null, email: string, groups: string[] = []): Promise<string[]> {
    return choices('base-choices', current, email, groups);
  }

  async function portionChoices(current: string, email: string, groups: string[] = []): Promise<string[]> {
    return choices('portion-choices', current, email, groups);
  }

  async function lowering(from: string, to: string): Promise<{ statusCode: number; body: unknown }> {
    const response = await server.inject({ method: 'POST', url: '/labels/lowering', payload: { from, to } });
    return { statusCode: response.statusCode, body: response.json() };
  }

  // The codes of the labels decided, and whether each is granted.
  async function decisions(codes: (string | null)[], email: string | null): Promise<{ granted: boolean; code: string | null }[]> {
    const headers = email === null ? {} : { 'x-user-email': encodeURIComponent(email) };
    const response = await server.inject({ method: 'POST', url: '/labels/decisions', headers, payload: { codes } });
    assert.equal(response.statusCode, 200);
    const body: unknown = response.json();
    assert.ok(typeof body === 'object' && body !== null && 'decisions' in body && Array.isArray(body.decisions), 'expected decisions');
    return body.decisions.map((decision: unknown) => {
      assert.ok(typeof decision === 'object' && decision !== null && 'granted' in decision && typeof decision.granted === 'boolean', 'expected a decision');
      const label: unknown = 'label' in decision ? decision.label : null;
      return { granted: decision.granted, code: typeof label === 'object' && label !== null && 'code' in label ? String(label.code) : null };
    });
  }

  it('offers anyone the labels that do not lower the current one', async () => {
    assert.deepEqual(await baseChoices('DEMO-FR:2', 'bob.walker@dcs.test', ['dcs-maquette']), ['DEMO-FR:2', 'DEMO-FR:2/1.1', 'DEMO-FR:2/2.1']);
    assert.deepEqual(await baseChoices('DEMO-FR:2/1.1', 'bob.walker@dcs.test', ['dcs-maquette']), ['DEMO-FR:2/1.1']);
  });

  it('offers every label to an administrator whose clearance allows the current one', async () => {
    assert.deepEqual(await baseChoices('DEMO-FR:2/1.1', 'alice.martin@dcs.test', ['dcs-maquette', 'dcs-maquette-admin']), EVERY_LABEL);
    assert.deepEqual(await baseChoices('DEMO-FR:2/1.1', 'chloe.bernard@dcs.test', ['dcs-maquette-admin']), ['DEMO-FR:2/1.1']);
  });

  it('offers every label to a document without a base label yet', async () => {
    assert.deepEqual(await baseChoices(null, 'chloe.bernard@dcs.test'), EVERY_LABEL);
  });

  // An author never writes what they could not read, so a portion is only
  // offered the labels the author's clearance allows.
  it('offers an author the labels their clearance allows that do not lower a portion label', async () => {
    assert.deepEqual(await portionChoices('DEMO-FR:2', 'alice.martin@dcs.test', ['dcs-maquette']), ['DEMO-FR:2', 'DEMO-FR:2/1.1', 'DEMO-FR:2/2.1']);
    assert.deepEqual(await portionChoices('DEMO-FR:2', 'bob.walker@dcs.test', ['dcs-maquette']), ['DEMO-FR:2', 'DEMO-FR:2/2.1']);
    assert.deepEqual(await portionChoices('DEMO-FR:1', 'chloe.bernard@dcs.test', ['dcs-maquette']), ['DEMO-FR:1']);
  });

  it('offers lower portion labels to an administrator whose clearance allows the current one', async () => {
    assert.deepEqual(await portionChoices('DEMO-FR:2/1.1', 'alice.martin@dcs.test', ['dcs-maquette', 'dcs-maquette-admin']), EVERY_LABEL);
    assert.deepEqual(await portionChoices('DEMO-FR:2/1.1', 'bob.walker@dcs.test', ['dcs-maquette', 'dcs-maquette-admin']), []);
  });

  it('refuses portion choices without a valid current label', async () => {
    const headers = { 'x-user-email': encodeURIComponent('alice.martin@dcs.test') };
    assert.equal((await server.inject({ method: 'GET', url: '/policies/DEMO-FR/labels/portion-choices', headers })).statusCode, 400);
    assert.equal((await server.inject({ method: 'GET', url: '/policies/DEMO-FR/labels/portion-choices?current=DEMO-FR%3A9', headers })).statusCode, 422);
  });

  it("decides who opens a document from its base label and the caller's clearance", async () => {
    const codes = ['DEMO-FR:1', 'DEMO-FR:2/1.1', 'demo-fr:2/2.1'];
    assert.deepEqual(await decisions(codes, 'bob.walker@dcs.test'), [
      { granted: true, code: 'DEMO-FR:1' },
      { granted: false, code: 'DEMO-FR:2/1.1' },
      { granted: true, code: 'DEMO-FR:2/2.1' },
    ]);
    assert.deepEqual(await decisions(['DEMO-FR:1'], 'dan.moreau@dcs.test'), [{ granted: false, code: 'DEMO-FR:1' }]);
  });

  it('decides a document without a base label as the least restrictive label, and refuses an unknown one', async () => {
    assert.deepEqual(await decisions([null], 'chloe.bernard@dcs.test'), [{ granted: true, code: 'DEMO-FR:1' }]);
    assert.deepEqual(await decisions([null], 'dan.moreau@dcs.test'), [{ granted: false, code: 'DEMO-FR:1' }]);
    assert.deepEqual(await decisions(['DEMO-FR:9', 'MARS:1'], 'alice.martin@dcs.test'), [
      { granted: false, code: null },
      { granted: false, code: null },
    ]);
  });

  it('tells whether a new base label lowers the previous one', async () => {
    assert.deepEqual(await lowering('DEMO-FR:2/1.1', 'DEMO-FR:2'), { statusCode: 200, body: { lowering: true } });
    assert.deepEqual(await lowering('DEMO-FR:2', 'DEMO-FR:1'), { statusCode: 200, body: { lowering: true } });
    assert.deepEqual(await lowering('DEMO-FR:2', 'DEMO-FR:2/1.1'), { statusCode: 200, body: { lowering: false } });
    assert.deepEqual(await lowering('DEMO-FR:2', 'DEMO-FR:2/2.1'), { statusCode: 200, body: { lowering: false } });
    assert.equal((await lowering('DEMO-FR:2', 'DEMO-FR:9')).statusCode, 422);
    assert.equal((await lowering('DEMO-FR:2', 'MARS:1')).statusCode, 422);
  });
});

describe('clearance directory administration', () => {
  let server: FastifyInstance;
  const SECRET = 'fictional-administration-secret';
  const admin = { authorization: `Bearer ${SECRET}` };
  before(async () => {
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      clearanceDirectory: { store: new MemoryClearanceStore(), seedFolder: DEMO_SEEDS },
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

  it('changes the terms of an entry, keeps who it belongs to, and answers with the entry before and after the change', async () => {
    const terms = {
      classification: 'diffusion restreinte',
      categories: ['Releasable To:NATO', 'Special Handling:SPECIAL FRANCE'],
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2030-01-01T00:00:00Z',
    };
    const bob = { email: 'bob.walker@dcs.test', name: 'Bob Walker', nationality: 'GBR', policy: 'DEMO-FR' };

    const response = await server.inject({ method: 'PUT', url: bobUrl, headers: admin, payload: terms });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      before: {
        ...bob,
        classification: 'DIFFUSION RESTREINTE',
        categories: ['Releasable To:NATO'],
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2036-01-01T00:00:00.000Z',
      },
      after: {
        ...bob,
        classification: 'DIFFUSION RESTREINTE',
        categories: ['Releasable To:NATO', 'Special Handling:SPECIAL FRANCE'],
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
      },
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
