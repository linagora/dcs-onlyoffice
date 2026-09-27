import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildPolicyServer } from '../src/server.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const EXAMPLE_SPIFS = path.join(import.meta.dirname, 'fixtures', 'example');
const DEMO_ATTRIBUTES = 'https://demo-fr.dcs.linagora.com/attr';
const DEMO_SPIF = readFileSync(path.join(DEMO_SPIFS, 'demo-fr.spif.xml'), 'utf8');

// A folder holding the demo SPIF, changed as a test needs.
async function spifFolder(...spifs: string[]): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'dcs-spif-'));
  for (const [index, spif] of spifs.entries()) {
    await writeFile(path.join(folder, `policy-${index}.spif.xml`), spif);
  }
  return folder;
}

function changed(spif: string, from: string, to: string): string {
  assert.ok(spif.includes(from), `the SPIF holds ${from}`);
  return spif.replace(from, to);
}

async function stateError(spif: string): Promise<unknown> {
  const server = await buildPolicyServer({ spifDirectory: await spifFolder(spif) });
  try {
    const response = await server.inject({ method: 'GET', url: '/policies/DEMO-FR/opentdf' });
    assert.equal(response.statusCode, 422);
    return response.json();
  } finally {
    await server.close();
  }
}

async function attributesOf(server: FastifyInstance, policy: string, code: string): Promise<{ statusCode: number; body: unknown }> {
  const response = await server.inject({ method: 'POST', url: `/policies/${policy}/labels/attributes`, payload: { code } });
  return { statusCode: response.statusCode, body: response.json() };
}

// Expected names follow ADR 0003: the classification is a hierarchy, highest
// value first, each restrictive tag set an all-of attribute, each permissive
// one an any-of attribute, and informative tag sets nothing. The claims are
// those the clearance directory gives OpenTDF (see clearance-directory.test.ts).
describe('OpenTDF state of the demo policy', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: DEMO_SPIFS });
  });
  after(async () => {
    await server.close();
  });

  it('derives the attributes and subject mappings from the SPIF', async () => {
    const response = await server.inject({ method: 'GET', url: '/policies/DEMO-FR/opentdf' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      namespace: 'demo-fr.dcs.linagora.com',
      attributes: [
        { name: 'classification', rule: 'HIERARCHY', values: ['diffusion-restreinte', 'non-protege'] },
        { name: 'special-handling', rule: 'ALL_OF', values: ['special-france'] },
        { name: 'releasable-to', rule: 'ANY_OF', values: ['nato'] },
      ],
      subjectMappings: [
        {
          valueFqn: 'https://demo-fr.dcs.linagora.com/attr/classification/value/diffusion-restreinte',
          selector: '.classifications[]',
          claimValue: 'DEMO-FR:DIFFUSION RESTREINTE',
        },
        {
          valueFqn: 'https://demo-fr.dcs.linagora.com/attr/classification/value/non-protege',
          selector: '.classifications[]',
          claimValue: 'DEMO-FR:NON PROTEGE',
        },
        {
          valueFqn: 'https://demo-fr.dcs.linagora.com/attr/special-handling/value/special-france',
          selector: '.categories[]',
          claimValue: 'DEMO-FR:Special Handling:SPECIAL FRANCE',
        },
        {
          valueFqn: 'https://demo-fr.dcs.linagora.com/attr/releasable-to/value/nato',
          selector: '.categories[]',
          claimValue: 'DEMO-FR:Releasable To:NATO',
        },
      ],
    });
  });

  it('names the attribute values of each label, from its classification and categories', async () => {
    assert.deepEqual(await attributesOf(server, 'DEMO-FR', 'DEMO-FR:1'), {
      statusCode: 200,
      body: { attributes: [`${DEMO_ATTRIBUTES}/classification/value/non-protege`] },
    });
    assert.deepEqual(await attributesOf(server, 'DEMO-FR', 'DEMO-FR:2/1.1'), {
      statusCode: 200,
      body: {
        attributes: [`${DEMO_ATTRIBUTES}/classification/value/diffusion-restreinte`, `${DEMO_ATTRIBUTES}/special-handling/value/special-france`],
      },
    });
    assert.deepEqual(await attributesOf(server, 'DEMO-FR', 'DEMO-FR:2/2.1'), {
      statusCode: 200,
      body: { attributes: [`${DEMO_ATTRIBUTES}/classification/value/diffusion-restreinte`, `${DEMO_ATTRIBUTES}/releasable-to/value/nato`] },
    });
  });

  it('gives informative categories no attribute', async () => {
    // DIFFUSION RESTREINTE with the rollup indicator, as a document label has it.
    assert.deepEqual(await attributesOf(server, 'DEMO-FR', 'DEMO-FR:2/3.1'), {
      statusCode: 200,
      body: { attributes: [`${DEMO_ATTRIBUTES}/classification/value/diffusion-restreinte`] },
    });
  });

  it('refuses a code that does not designate a valid label', async () => {
    const { statusCode } = await attributesOf(server, 'DEMO-FR', 'DEMO-FR:1/1.1');
    assert.equal(statusCode, 422);
  });
});

describe('OpenTDF state of a policy without an attribute namespace', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: EXAMPLE_SPIFS });
  });
  after(async () => {
    await server.close();
  });

  it('reports that the policy cannot be provisioned', async () => {
    const expected = { error: 'EXAMPLE cannot be provisioned in OpenTDF: its SPIF declares no attribute namespace' };

    const state = await server.inject({ method: 'GET', url: '/policies/EXAMPLE/opentdf' });
    assert.equal(state.statusCode, 422);
    assert.deepEqual(state.json(), expected);
    assert.deepEqual(await attributesOf(server, 'EXAMPLE', 'EXAMPLE:2/1.1/2.1+2'), { statusCode: 422, body: expected });
  });
});

describe('policies OpenTDF cannot hold', () => {
  it('refuses an attribute namespace that is not a host name', async () => {
    assert.deepEqual(await stateError(changed(DEMO_SPIF, 'name="demo-fr.dcs.linagora.com"', 'name="demo fr"')), {
      error: 'DEMO-FR cannot be provisioned in OpenTDF: its attribute namespace "demo fr" is not a host name',
    });
  });

  it('refuses names that OpenTDF would write the same way', async () => {
    const spif = changed(DEMO_SPIF, 'securityClassification name="DIFFUSION RESTREINTE"', 'securityClassification name="Non Protégé"');
    assert.deepEqual(await stateError(spif), {
      error: 'DEMO-FR cannot be provisioned in OpenTDF: Non Protégé and NON PROTEGE are both written non-protege',
    });
    assert.deepEqual(await stateError(changed(DEMO_SPIF, 'tagCategory name="NATO"', 'tagCategory name="***"')), {
      error: 'DEMO-FR cannot be provisioned in OpenTDF: *** has no letter or digit to write',
    });
  });

  it('refuses classifications that share a hierarchy level', async () => {
    assert.deepEqual(await stateError(changed(DEMO_SPIF, 'hierarchy="2"', 'hierarchy="1"')), {
      error: 'DEMO-FR cannot be provisioned in OpenTDF: NON PROTEGE and DIFFUSION RESTREINTE share a hierarchy level',
    });
  });

  it('refuses two policies that declare the same attribute namespace', async () => {
    const other = changed(DEMO_SPIF, 'securityPolicyId name="DEMO-FR"', 'securityPolicyId name="DEMO-FR-2"');
    const server = await buildPolicyServer({ spifDirectory: await spifFolder(DEMO_SPIF, other) });
    try {
      const first = await server.inject({ method: 'GET', url: '/policies/DEMO-FR/opentdf' });
      const second = await server.inject({ method: 'GET', url: '/policies/DEMO-FR-2/opentdf' });
      assert.deepEqual([first.statusCode, first.json()], [422, { error: 'DEMO-FR cannot be provisioned in OpenTDF: policy DEMO-FR-2 declares the same attribute namespace' }]);
      assert.deepEqual([second.statusCode, second.json()], [422, { error: 'DEMO-FR-2 cannot be provisioned in OpenTDF: policy DEMO-FR declares the same attribute namespace' }]);
    } finally {
      await server.close();
    }
  });
});
