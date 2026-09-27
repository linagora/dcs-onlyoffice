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

interface ValidationAnswer {
  valid: boolean;
  label: unknown;
}

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const EXAMPLE_SPIFS = path.join(import.meta.dirname, 'fixtures', 'example');
const BROKEN_SPIFS = path.join(import.meta.dirname, 'fixtures', 'broken');
const REFERENCE_LABEL = readFileSync(path.join(import.meta.dirname, 'fixtures', 'reference-label.xml'), 'utf8');
const FIXED_NOW = (): Date => new Date('2026-09-26T12:00:00Z');

function validationAnswerOf(body: unknown): ValidationAnswer {
  assert.ok(typeof body === 'object' && body !== null && 'valid' in body && typeof body.valid === 'boolean', 'expected a validation answer');
  return { valid: body.valid, label: 'label' in body ? body.label : null };
}

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
  const body: unknown = response.json();
  assert.ok(Array.isArray(body), 'expected a label list');
  return body as LabelView[]; // SAFETY: the service's label views; each test compares the fields it names
}

// The label of a validation or document-label answer.
function labelOf(body: unknown): LabelView {
  assert.ok(typeof body === 'object' && body !== null && 'label' in body, 'expected an answer with a label');
  return body.label as LabelView; // SAFETY: the service's label view; each test compares the fields it names
}

// The XML of a serialization answer.
function xmlOf(body: unknown): string {
  assert.ok(typeof body === 'object' && body !== null && 'xml' in body && typeof body.xml === 'string', 'expected an answer with XML');
  return body.xml;
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

  async function validateDemo(body: Record<string, unknown>): Promise<ValidationAnswer> {
    const response = await server.inject({ method: 'POST', url: '/policies/DEMO-FR/labels/validate', payload: body });
    assert.equal(response.statusCode, 200);
    return validationAnswerOf(response.json());
  }

  it('accepts SPECIAL FRANCE on DIFFUSION RESTREINTE and renders its marking', async () => {
    const answer = await validateDemo({
      classification: 'DIFFUSION RESTREINTE',
      categories: [{ tagSet: 'Special Handling', values: ['SPECIAL FRANCE'] }],
    });
    assert.equal(answer.valid, true);
    assert.equal(labelOf(answer).marking.text, 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE');
  });

  it('refuses SPECIAL FRANCE on NON PROTEGE', async () => {
    const answer = await validateDemo({
      classification: 'NON PROTEGE',
      categories: [{ tagSet: 'Special Handling', values: ['SPECIAL FRANCE'] }],
    });
    assert.equal(answer.valid, false);
  });

  it('refuses a release to NATO on NON PROTEGE', async () => {
    const answer = await validateDemo({
      classification: 'NON PROTEGE',
      categories: [{ tagSet: 'Releasable To', values: ['NATO'] }],
    });
    assert.equal(answer.valid, false);
  });

  it('refuses SPECIAL FRANCE together with a release to NATO', async () => {
    const answer = await validateDemo({
      classification: 'DIFFUSION RESTREINTE',
      categories: [
        { tagSet: 'Special Handling', values: ['SPECIAL FRANCE'] },
        { tagSet: 'Releasable To', values: ['NATO'] },
      ],
    });
    assert.equal(answer.valid, false);
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

  async function validate(body: Record<string, unknown>, lang?: string): Promise<{ statusCode: number; json: ValidationAnswer }> {
    const query = lang === undefined ? '' : `?lang=${lang}`;
    const response = await server.inject({ method: 'POST', url: `/policies/EXAMPLE/labels/validate${query}`, payload: body });
    return { statusCode: response.statusCode, json: validationAnswerOf(response.json()) };
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
    assert.deepEqual(labelOf(json).marking.text, 'EXAMPLE RESTRICTED ALPHA REL TO XAA, XBB');
  });

  it('renders the marking in another language when the SPIF has phrases for it', async () => {
    const { json } = await validate(referenceLabel, 'fr');
    assert.deepEqual(labelOf(json).marking.text, 'EXAMPLE RESTREINT ALPHA REL TO XAA, XBB');
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
    assert.deepEqual(labelOf(json).categories, [{ tagSet: 'Releasable To', type: 'PERMISSIVE', values: ['XAA'] }]);
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
    assert.equal(compactXml(xmlOf(response.json())), compactXml(REFERENCE_LABEL));
  });

  it('serializes a demo label with its policy OID and typed category', async () => {
    const response = await demoServer.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/labels/adatp4774',
      payload: { code: 'DEMO-FR:2/1.1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      compactXml(xmlOf(response.json())),
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

  async function documentLabel(server: FastifyInstance, base: string, portions: string[]): Promise<{ label: LabelView; moreRestrictivePortions: unknown }> {
    const response = await server.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/document-label',
      payload: { base, portions },
    });
    assert.equal(response.statusCode, 200);
    const body: unknown = response.json();
    return { label: labelOf(body), moreRestrictivePortions: typeof body === 'object' && body !== null && 'moreRestrictivePortions' in body ? body.moreRestrictivePortions : null };
  }

  it('keeps the base label and flags a more restrictive portion under the clear-parts rule', async () => {
    const result = await documentLabel(clearParts, 'DEMO-FR:2/2.1', ['DEMO-FR:2/1.1']);
    assert.equal(result.moreRestrictivePortions, true);
    assert.equal(result.label.code, 'DEMO-FR:2/2.1/3.1');
    assert.equal(
      result.label.marking.text,
      'DIFFUSION RESTREINTE – DIFFUSION OTAN – CONTIENT DES PORTIONS PLUS RESTRICTIVES',
    );
  });

  const NP = 'DEMO-FR:1';
  const DR = 'DEMO-FR:2';
  const DR_SF = 'DEMO-FR:2/1.1';
  const DR_NATO = 'DEMO-FR:2/2.1';

  // Every base label against every portion label. A portion is more
  // restrictive when a reader allowed by the base label can be refused the
  // portion by the SPIF access decision: higher classification, a restrictive
  // category the base lacks, or a permissive category the base does not
  // impose. Plain DIFFUSION RESTREINTE imposes no release category, so a
  // portion releasable to NATO only is more restrictive than it, while a
  // portion without release category never is on that account.
  const clearPartsMatrix: Record<string, Record<string, string>> = {
    [NP]: { [NP]: NP, [DR]: 'DEMO-FR:1/3.1', [DR_SF]: 'DEMO-FR:1/3.1', [DR_NATO]: 'DEMO-FR:1/3.1' },
    [DR]: { [NP]: DR, [DR]: DR, [DR_SF]: 'DEMO-FR:2/3.1', [DR_NATO]: 'DEMO-FR:2/3.1' },
    [DR_SF]: { [NP]: DR_SF, [DR]: DR_SF, [DR_SF]: DR_SF, [DR_NATO]: 'DEMO-FR:2/1.1/3.1' },
    [DR_NATO]: { [NP]: DR_NATO, [DR]: DR_NATO, [DR_SF]: 'DEMO-FR:2/2.1/3.1', [DR_NATO]: DR_NATO },
  };
  for (const [base, row] of Object.entries(clearPartsMatrix)) {
    for (const [portion, expected] of Object.entries(row)) {
      it(`clear-parts: ${base} with [${portion}] gives ${expected}`, async () => {
        assert.equal((await documentLabel(clearParts, base, [portion])).label.code, expected);
      });
    }
  }

  const clearPartsSeveralPortionsCases: [string, string[], string][] = [
    [DR_NATO, [NP, DR_NATO], DR_NATO],
    [NP, [NP, DR_SF], 'DEMO-FR:1/3.1'],
    [DR, [], DR],
  ];
  for (const [base, portions, expected] of clearPartsSeveralPortionsCases) {
    it(`clear-parts: ${base} with [${portions.join(', ')}] gives ${expected}`, async () => {
      assert.equal((await documentLabel(clearParts, base, portions)).label.code, expected);
    });
  }

  // ADatP-4774.1 section 4.4: highest classification, restrictive categories
  // united, permissive categories intersected and dropped when one label lacks
  // them. The standard reads release categories as widening dissemination: a
  // part without one makes the whole not releasable. So NON PROTÉGÉ with
  // DIFFUSION RESTREINTE releasable to NATO gives plain DIFFUSION RESTREINTE,
  // although the access decision would refuse the second part to a reader
  // without NATO. The clear-parts rule flags that case.
  const highWaterMarkMatrix: Record<string, Record<string, string>> = {
    [NP]: { [NP]: NP, [DR]: DR, [DR_SF]: DR_SF, [DR_NATO]: DR },
    [DR]: { [NP]: DR, [DR]: DR, [DR_SF]: DR_SF, [DR_NATO]: DR },
    [DR_SF]: { [NP]: DR_SF, [DR]: DR_SF, [DR_SF]: DR_SF, [DR_NATO]: DR_SF },
    [DR_NATO]: { [NP]: DR, [DR]: DR, [DR_SF]: DR_SF, [DR_NATO]: DR_NATO },
  };
  for (const [base, row] of Object.entries(highWaterMarkMatrix)) {
    for (const [portion, expected] of Object.entries(row)) {
      it(`high-water-mark: ${base} with [${portion}] gives ${expected}`, async () => {
        assert.equal((await documentLabel(highWaterMark, base, [portion])).label.code, expected);
      });
    }
  }

  const highWaterMarkSeveralPortionsCases: [string, string[], string][] = [
    [DR_NATO, [DR_NATO, DR_NATO], DR_NATO],
    [DR_NATO, [DR_NATO, NP], DR],
    [DR_NATO, [], DR_NATO],
  ];
  for (const [base, portions, expected] of highWaterMarkSeveralPortionsCases) {
    it(`high-water-mark: ${base} with [${portions.join(', ')}] gives ${expected}`, async () => {
      assert.equal((await documentLabel(highWaterMark, base, portions)).label.code, expected);
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
      compactXml(xmlOf(response.json())),
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
    const uris = [...xmlOf(response.json()).matchAll(/DataReference URI="([^"]+)"/g)].map((match) => match[1]);
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
