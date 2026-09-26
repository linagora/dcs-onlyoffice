import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const REFERENCE_LABEL = readFileSync(path.join(import.meta.dirname, 'fixtures', 'reference-label.xml'), 'utf8');
const FIXED_NOW = (): Date => new Date('2026-09-26T12:00:00Z');

// Whitespace between and inside tags carries no meaning here.
function compactXml(xml: string): string {
  return xml
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .replace(/ >/g, '>')
    .trim();
}

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

// The reference label was validated against the ADatP-4774 XSD and by
// spiffing-java (docs/research/labelling-standards.md, section 2.5).
describe('ADatP-4774 serialization', () => {
  let exampleServer: FastifyInstance;
  let demoServer: FastifyInstance;
  before(async () => {
    exampleServer = await buildPolicyServer({ spifDirectory: EXAMPLE_SPIFS, now: FIXED_NOW, reviewPeriodYears: 5 });
    demoServer = await buildPolicyServer({ spifDirectory: DEMO_SPIFS, now: FIXED_NOW, reviewPeriodYears: 5 });
  });
  after(async () => {
    await exampleServer.close();
    await demoServer.close();
  });

  it('produces the reference originator label for a label code', async () => {
    const response = await exampleServer.inject({
      method: 'POST',
      url: '/policies/EXAMPLE/labels/adatp4774',
      headers: { 'x-user-email': encodeURIComponent('author@example.org') },
      payload: { code: 'EXAMPLE:2/1.1/2.1+2' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(compactXml(response.json().xml), compactXml(REFERENCE_LABEL));
  });

  it('serializes a demo label with its policy OID and typed category', async () => {
    const response = await demoServer.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/labels/adatp4774',
      payload: { code: 'DEMO-FR:2/1.1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      compactXml(response.json().xml),
      compactXml(`<slab:originatorConfidentialityLabel xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0" ReviewDateTime="2031-09-26T00:00:00Z">
        <slab:ConfidentialityInformation>
          <slab:PolicyIdentifier URI="urn:oid:2.25.166231019600111174217682845337071458325">DEMO-FR</slab:PolicyIdentifier>
          <slab:Classification>DIFFUSION RESTREINTE</slab:Classification>
          <slab:Category Type="RESTRICTIVE" TagName="Special Handling" URI="urn:oid:2.25.166231019600111174217682845337071458325.1">
            <slab:GenericValue>SPECIAL FRANCE</slab:GenericValue>
          </slab:Category>
        </slab:ConfidentialityInformation>
        <slab:CreationDateTime>2026-09-26T12:00:00Z</slab:CreationDateTime>
      </slab:originatorConfidentialityLabel>`),
    );
  });

  it('refuses a code that does not designate a valid label', async () => {
    const response = await demoServer.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/labels/adatp4774',
      payload: { code: 'DEMO-FR:1/1.1' },
    });
    assert.equal(response.statusCode, 422);
  });
});

describe('document label rollup with the demo SPIF', () => {
  let clearParts: FastifyInstance;
  let highWaterMark: FastifyInstance;
  before(async () => {
    clearParts = await buildPolicyServer({ spifDirectory: DEMO_SPIFS, markingLanguage: 'fr', now: FIXED_NOW });
    highWaterMark = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      markingLanguage: 'fr',
      now: FIXED_NOW,
      rollupRule: 'high-water-mark',
    });
  });
  after(async () => {
    await clearParts.close();
    await highWaterMark.close();
  });

  async function documentLabel(server: FastifyInstance, base: string, portions: string[]): Promise<Record<string, unknown>> {
    const response = await server.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/document-label',
      payload: { base, portions },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  }

  it('keeps the base label and flags a more restrictive portion under the clear-parts rule', async () => {
    const result = await documentLabel(clearParts, 'DEMO-FR:2/2.1', ['DEMO-FR:2/1.1']);
    assert.equal(result.moreRestrictivePortions, true);
    assert.equal((result.label as LabelView).code, 'DEMO-FR:2/2.1/3.1');
    assert.equal(
      (result.label as LabelView).marking.text,
      'DIFFUSION RESTREINTE – DIFFUSION OTAN – CONTIENT DES PORTIONS PLUS RESTRICTIVES',
    );
  });

  // Each case: base label, portion labels, expected document label code. A
  // portion is more restrictive when a reader allowed by the base label can be
  // refused the portion (ADatP-4774 access decision): higher classification,
  // extra restrictive category, or a permissive category the base does not
  // impose. Plain DIFFUSION RESTREINTE imposes no release category, so a
  // portion releasable to NATO only is more restrictive than it.
  const clearPartsCases: [string, string[], string][] = [
    ['DEMO-FR:2/2.1', ['DEMO-FR:1', 'DEMO-FR:2/2.1'], 'DEMO-FR:2/2.1'],
    ['DEMO-FR:2/2.1', ['DEMO-FR:2'], 'DEMO-FR:2/2.1'],
    ['DEMO-FR:2', ['DEMO-FR:2/2.1'], 'DEMO-FR:2/3.1'],
    ['DEMO-FR:1', ['DEMO-FR:2'], 'DEMO-FR:1/3.1'],
    ['DEMO-FR:1/2.1', ['DEMO-FR:1'], 'DEMO-FR:1/2.1'],
    ['DEMO-FR:2', [], 'DEMO-FR:2'],
  ];
  for (const [base, portions, expected] of clearPartsCases) {
    it(`clear-parts: ${base} with [${portions.join(', ')}] gives ${expected}`, async () => {
      assert.equal(((await documentLabel(clearParts, base, portions)).label as LabelView).code, expected);
    });
  }

  // ADatP-4774.1 section 4.4: highest classification, restrictive categories
  // united, permissive categories intersected.
  const highWaterMarkCases: [string, string[], string][] = [
    ['DEMO-FR:2/2.1', ['DEMO-FR:2/1.1'], 'DEMO-FR:2/1.1'],
    ['DEMO-FR:1/2.1', ['DEMO-FR:2/2.1'], 'DEMO-FR:2/2.1'],
    ['DEMO-FR:1', ['DEMO-FR:2/2.1'], 'DEMO-FR:2'],
    ['DEMO-FR:2/2.1', [], 'DEMO-FR:2/2.1'],
  ];
  for (const [base, portions, expected] of highWaterMarkCases) {
    it(`high-water-mark: ${base} with [${portions.join(', ')}] gives ${expected}`, async () => {
      assert.equal(((await documentLabel(highWaterMark, base, portions)).label as LabelView).code, expected);
    });
  }

  it('never offers the rollup indicator as a label an author can pick', async () => {
    const labels = await listLabels(clearParts, 'DEMO-FR');
    assert.equal(labels.some((label) => label.code.includes('/3.')), false);
  });
});

// The expected part is the tested example of docs/research/labelling-standards.md,
// section 4.5, with the optional Category URIs that section 2.5 validates.
describe('ADatP-4778.2 document label part', () => {
  let server: FastifyInstance;
  before(async () => {
    server = await buildPolicyServer({ spifDirectory: EXAMPLE_SPIFS, now: FIXED_NOW });
  });
  after(async () => {
    await server.close();
  });

  it('binds the document label to the listed package parts', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/policies/EXAMPLE/document-label',
      payload: {
        base: 'EXAMPLE:2/1.1/2.1+2/3.1',
        portions: [],
        parts: [
          'word/document.xml',
          'word/styles.xml',
          'word/header1.xml',
          'word/footer1.xml',
          'word/footnotes.xml',
          'word/endnotes.xml',
          'word/comments.xml',
          'word/media/image1.png',
          'docProps/core.xml',
          'docProps/app.xml',
          'docProps/custom.xml',
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    const oid = '2.25.283505922519774543341581604402970826256';
    assert.equal(
      compactXml(response.json().xml),
      compactXml(`<mb:BindingInformation xmlns:mb="urn:nato:stanag:4778:bindinginformation:1:0" xmlns:xmime="http://www.w3.org/2005/05/xmlmime">
        <mb:MetadataBindingContainer>
          <mb:MetadataBinding Id="mb-document">
            <mb:Metadata>
              <slab:originatorConfidentialityLabel xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0" ReviewDateTime="2031-09-26T00:00:00Z">
                <slab:ConfidentialityInformation>
                  <slab:PolicyIdentifier URI="urn:oid:${oid}">EXAMPLE</slab:PolicyIdentifier>
                  <slab:Classification>RESTRICTED</slab:Classification>
                  <slab:Category Type="RESTRICTIVE" TagName="Special Handling" URI="urn:oid:${oid}.1">
                    <slab:GenericValue>ALPHA</slab:GenericValue>
                  </slab:Category>
                  <slab:Category Type="PERMISSIVE" TagName="Releasable To" URI="urn:oid:${oid}.2">
                    <slab:GenericValue>XAA</slab:GenericValue>
                    <slab:GenericValue>XBB</slab:GenericValue>
                  </slab:Category>
                  <slab:Category Type="INFORMATIVE" TagName="Administrative" URI="urn:oid:${oid}.3">
                    <slab:GenericValue>STAFF</slab:GenericValue>
                  </slab:Category>
                </slab:ConfidentialityInformation>
                <slab:CreationDateTime>2026-09-26T12:00:00Z</slab:CreationDateTime>
              </slab:originatorConfidentialityLabel>
            </mb:Metadata>
            <mb:DataReference URI="pack:///word/document.xml"/>
            <mb:DataReference URI="pack:///word/styles.xml"/>
            <mb:DataReference URI="pack:///word/header1.xml"/>
            <mb:DataReference URI="pack:///word/footer1.xml"/>
            <mb:DataReference URI="pack:///word/footnotes.xml"/>
            <mb:DataReference URI="pack:///word/endnotes.xml"/>
            <mb:DataReference URI="pack:///word/comments.xml"/>
            <mb:DataReference URI="pack:///word/media/image1.png" xmime:contentType="image/png"/>
            <mb:DataReference URI="pack:///docProps/core.xml"/>
            <mb:DataReference URI="pack:///docProps/app.xml"/>
            <mb:DataReference URI="pack:///docProps/custom.xml"/>
          </mb:MetadataBinding>
        </mb:MetadataBindingContainer>
      </mb:BindingInformation>`),
    );
  });

  it('references the parts a document always has when none are listed', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/policies/EXAMPLE/document-label',
      payload: { base: 'EXAMPLE:1', portions: [] },
    });
    const uris = [...String(response.json().xml).matchAll(/DataReference URI="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(uris, [
      'pack:///word/document.xml',
      'pack:///word/styles.xml',
      'pack:///word/footnotes.xml',
      'pack:///word/endnotes.xml',
      'pack:///docProps/core.xml',
      'pack:///docProps/app.xml',
    ]);
  });
});

describe('policy service start-up', () => {
  it('refuses to start on a SPIF it cannot read, naming the file', async () => {
    await assert.rejects(buildPolicyServer({ spifDirectory: BROKEN_SPIFS }), /broken\.spif\.xml/);
  });
});
