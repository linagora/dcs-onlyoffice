import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildPolicyServer } from '../src/server.ts';

interface LabelView {
  code: string;
  classification: string;
  categories: { tagSet: string; type: string; values: string[] }[];
  marking: { text: string; color: string | null };
}

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const EXAMPLE_SPIFS = path.join(import.meta.dirname, 'fixtures', 'example');
const BROKEN_SPIFS = path.join(import.meta.dirname, 'fixtures', 'broken');

async function listLabels(server: FastifyInstance, policy: string): Promise<LabelView[]> {
  const response = await server.inject({ method: 'GET', url: `/policies/${policy}/labels` });
  assert.equal(response.statusCode, 200);
  return response.json();
}

describe('policy API with the demo SPIF', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: DEMO_SPIFS, markingLanguage: 'fr' });
  });
  after(async () => {
    await server.close();
  });

  it('lists the demo policy', async () => {
    const response = await server.inject({ method: 'GET', url: '/policies' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), [{ name: 'DEMO-FR', oid: '2.25.166231019600111174217682845337071458325' }]);
  });

  it('lists exactly the labels the demo policy allows, with their French markings', async () => {
    const labels = await listLabels(server, 'DEMO-FR');
    assert.deepEqual(
      labels.map((label) => label.marking.text),
      [
        'NON PROTÉGÉ',
        'NON PROTÉGÉ – DIFFUSION OTAN',
        'DIFFUSION RESTREINTE',
        'DIFFUSION RESTREINTE – SPÉCIAL FRANCE',
        'DIFFUSION RESTREINTE – DIFFUSION OTAN',
      ],
    );
  });

  it('gives every label a stable short code and the colour of its classification', async () => {
    const labels = await listLabels(server, 'DEMO-FR');
    assert.deepEqual(
      labels.map((label) => [label.code, label.marking.color]),
      [
        ['DEMO-FR:1', '#2E7D32'],
        ['DEMO-FR:1/2.1', '#2E7D32'],
        ['DEMO-FR:2', '#E8590C'],
        ['DEMO-FR:2/1.1', '#E8590C'],
        ['DEMO-FR:2/2.1', '#E8590C'],
      ],
    );
  });

  it('describes a label with its classification and typed categories', async () => {
    const labels = await listLabels(server, 'DEMO-FR');
    const specialFrance = labels.find((label) => label.code === 'DEMO-FR:2/1.1');
    assert.deepEqual(specialFrance?.classification, 'DIFFUSION RESTREINTE');
    assert.deepEqual(specialFrance?.categories, [
      { tagSet: 'Special Handling', type: 'RESTRICTIVE', values: ['SPECIAL FRANCE'] },
    ]);
  });

  it('answers 404 for an unknown policy', async () => {
    const response = await server.inject({ method: 'GET', url: '/policies/UNKNOWN/labels' });
    assert.equal(response.statusCode, 404);
  });
});

// Expected markings and verdicts come from running spiffing-java on the same
// SPIF and label (docs/research/labelling-standards.md, section 6.3).
describe('label validation with the reference EXAMPLE SPIF', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: EXAMPLE_SPIFS, markingLanguage: 'en' });
  });
  after(async () => {
    await server.close();
  });

  async function validate(body: Record<string, unknown>, lang?: string): Promise<{ statusCode: number; json: Record<string, unknown> }> {
    const query = lang === undefined ? '' : `?lang=${lang}`;
    const response = await server.inject({ method: 'POST', url: `/policies/EXAMPLE/labels/validate${query}`, payload: body });
    return { statusCode: response.statusCode, json: response.json() };
  }

  const referenceLabel = {
    classification: 'RESTRICTED',
    categories: [
      { tagSet: 'Special Handling', values: ['ALPHA'] },
      { tagSet: 'Releasable To', values: ['XAA', 'XBB'] },
    ],
  };

  it('accepts the reference label and renders its marking', async () => {
    const { statusCode, json } = await validate(referenceLabel);
    assert.equal(statusCode, 200);
    assert.equal(json.valid, true);
    assert.deepEqual((json.label as LabelView).marking.text, 'EXAMPLE RESTRICTED ALPHA REL TO XAA, XBB');
  });

  it('renders the marking in another language when the SPIF has phrases for it', async () => {
    const { json } = await validate(referenceLabel, 'fr');
    assert.deepEqual((json.label as LabelView).marking.text, 'EXAMPLE RESTREINT ALPHA REL TO XAA, XBB');
  });

  it('refuses a category excluded at the classification', async () => {
    const { json } = await validate({ classification: 'UNCLASSIFIED', categories: [{ tagSet: 'Special Handling', values: ['ALPHA'] }] });
    assert.equal(json.valid, false);
  });

  it('refuses a category that excludes another one', async () => {
    const { json } = await validate({
      classification: 'RESTRICTED',
      categories: [
        { tagSet: 'Special Handling', values: ['BRAVO'] },
        { tagSet: 'Releasable To', values: ['XAA'] },
      ],
    });
    assert.equal(json.valid, false);
  });

  it('refuses a category whose required category is missing', async () => {
    const { json } = await validate({ classification: 'RESTRICTED', categories: [{ tagSet: 'Releasable To', values: ['XBB'] }] });
    assert.equal(json.valid, false);
  });

  it('refuses an unknown classification', async () => {
    const { json } = await validate({ classification: 'TOP SECRET', categories: [] });
    assert.equal(json.valid, false);
  });

  it('matches names without regard to case and answers with the SPIF spelling', async () => {
    const { json } = await validate({ classification: 'restricted', categories: [{ tagSet: 'releasable to', values: ['xaa'] }] });
    assert.equal(json.valid, true);
    assert.deepEqual((json.label as LabelView).categories, [{ tagSet: 'Releasable To', type: 'PERMISSIVE', values: ['XAA'] }]);
  });
});

describe('policy service start-up', () => {
  it('refuses to start on a SPIF it cannot read, naming the file', async () => {
    await assert.rejects(buildPolicyServer({ spifDirectory: BROKEN_SPIFS }), /broken\.spif\.xml/);
  });
});
