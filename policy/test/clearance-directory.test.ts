import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Clearance } from '../src/directory/clearance.ts';
import type { ClearanceStore } from '../src/directory/store.ts';
import { buildPolicyServer } from '../src/server.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_SEEDS = path.join(import.meta.dirname, '..', '..', 'deploy', 'directory', 'seeds');

// Stands for PostgreSQL: remembers what the service adds.
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
