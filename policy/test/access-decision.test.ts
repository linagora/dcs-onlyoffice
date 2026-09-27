import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildPolicyServer } from '../src/server.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const EXAMPLE_SPIFS = path.join(import.meta.dirname, 'fixtures', 'example');

interface ClearanceBody {
  classification: string;
  categories: string[];
}

async function decide(server: FastifyInstance, policy: string, clearance: ClearanceBody | null, code: string): Promise<{ statusCode: number; body: unknown }> {
  const response = await server.inject({ method: 'POST', url: `/policies/${policy}/access-decision`, payload: { clearance, code } });
  return { statusCode: response.statusCode, body: response.json() };
}

async function granted(server: FastifyInstance, policy: string, clearance: ClearanceBody | null, code: string): Promise<boolean> {
  const { statusCode, body } = await decide(server, policy, clearance, code);
  assert.equal(statusCode, 200);
  assert.ok(typeof body === 'object' && body !== null && 'granted' in body && typeof body.granted === 'boolean', 'expected a decision');
  return body.granted;
}

// Worked examples of the SPIF access rules, which spiffing's access control
// decision implements: a clearance reads the classifications up to its own,
// must hold every restrictive category of the label and one of its values in
// each permissive category, while informative categories play no part.
describe('access decisions under the demo policy', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: DEMO_SPIFS });
  });
  after(async () => {
    await server.close();
  });

  const nonProtege = 'DEMO-FR:1';
  const diffusionRestreinte = 'DEMO-FR:2';
  const specialFrance = 'DEMO-FR:2/1.1';
  const releasableToNato = 'DEMO-FR:2/2.1';

  it('refuses everything to someone without a clearance', async () => {
    assert.equal(await granted(server, 'DEMO-FR', null, nonProtege), false);
  });

  it('grants the classifications up to the clearance', async () => {
    const clearance = { classification: 'NON PROTEGE', categories: [] };
    assert.equal(await granted(server, 'DEMO-FR', clearance, nonProtege), true);
    assert.equal(await granted(server, 'DEMO-FR', clearance, diffusionRestreinte), false);
    assert.equal(await granted(server, 'DEMO-FR', { classification: 'DIFFUSION RESTREINTE', categories: [] }, nonProtege), true);
  });

  it('requires the restrictive categories of the label', async () => {
    assert.equal(await granted(server, 'DEMO-FR', { classification: 'DIFFUSION RESTREINTE', categories: [] }, specialFrance), false);
    const cleared = { classification: 'DIFFUSION RESTREINTE', categories: ['Special Handling:SPECIAL FRANCE'] };
    assert.equal(await granted(server, 'DEMO-FR', cleared, specialFrance), true);
  });

  it('requires a permissive category of the label', async () => {
    const withoutRelease = { classification: 'DIFFUSION RESTREINTE', categories: ['Special Handling:SPECIAL FRANCE'] };
    assert.equal(await granted(server, 'DEMO-FR', withoutRelease, releasableToNato), false);
    assert.equal(await granted(server, 'DEMO-FR', { classification: 'DIFFUSION RESTREINTE', categories: ['Releasable To:NATO'] }, releasableToNato), true);
  });

  it('ignores informative categories', async () => {
    // DIFFUSION RESTREINTE with the rollup indicator, as a document label has it.
    assert.equal(await granted(server, 'DEMO-FR', { classification: 'DIFFUSION RESTREINTE', categories: [] }, 'DEMO-FR:2/3.1'), true);
  });

  it('matches names without regard to case', async () => {
    const clearance = { classification: 'diffusion restreinte', categories: ['special handling:special france'] };
    assert.equal(await granted(server, 'DEMO-FR', clearance, specialFrance), true);
  });

  it('refuses a clearance the policy cannot hold, or an invalid label', async () => {
    assert.deepEqual(await decide(server, 'DEMO-FR', { classification: 'DIFFUSION RESTREINTE', categories: ['Releasable To:MARS'] }, nonProtege), {
      statusCode: 422,
      body: { error: 'DEMO-FR has no category Releasable To:MARS' },
    });
    assert.deepEqual(await decide(server, 'DEMO-FR', { classification: 'TRES SECRET', categories: [] }, nonProtege), {
      statusCode: 422,
      body: { error: 'DEMO-FR has no classification TRES SECRET' },
    });
    assert.equal((await decide(server, 'DEMO-FR', null, 'DEMO-FR:1/1.1')).statusCode, 422);
  });
});

describe('access decisions under the reference EXAMPLE policy', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: EXAMPLE_SPIFS });
  });
  after(async () => {
    await server.close();
  });

  // RESTRICTED, ALPHA, releasable to XAA and XBB.
  const reference = 'EXAMPLE:2/1.1/2.1+2';

  it('grants a label released to several parties to a clearance holding one of them', async () => {
    const clearance = { classification: 'RESTRICTED', categories: ['Special Handling:ALPHA', 'Releasable To:XBB'] };
    assert.equal(await granted(server, 'EXAMPLE', clearance, reference), true);
  });

  it('refuses the label when a restrictive category or the classification is missing', async () => {
    assert.equal(await granted(server, 'EXAMPLE', { classification: 'RESTRICTED', categories: ['Releasable To:XAA'] }, reference), false);
    const unclassified = { classification: 'UNCLASSIFIED', categories: ['Special Handling:ALPHA', 'Releasable To:XAA'] };
    assert.equal(await granted(server, 'EXAMPLE', unclassified, reference), false);
  });
});
