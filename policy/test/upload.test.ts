import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';
import { verifyWithXmlsec } from './xmlsec.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const DEMO_LABEL_MAPPING = path.join(DEMO_SPIFS, 'demo-fr.label-mapping.json');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SECRET = 'fictional-binding-signature-secret';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';
const CUSTOM_XML_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CUSTOM_XML_PROPERTIES_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';
// The first bytes of an OLE compound file ([MS-CFB] §2.2), as an encrypted
// Office document is one ([MS-OFFCRYPTO] §1.3.3.4).
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DEMO-FR:2/1.1';

// A compound file whose directory names the given streams, as UTF-16 names.
function compoundFile(streams: string[]): Uint8Array {
  return Buffer.concat([COMPOUND_FILE_SIGNATURE, Buffer.alloc(504), ...streams.map((name) => Buffer.from(`${name}\0`, 'utf16le'))]);
}

// The smallest WordprocessingML package: a main document part, without the
// relationships part, styles, notes or document properties that Word and
// ONLYOFFICE add, whose body holds the given content controls' tags.
async function minimalDocx(tags: string[] = [], customXml: string[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const controls = tags.map((tag) => `<w:sdt><w:sdtPr><w:tag w:val="${tag.replaceAll('"', '&quot;')}"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Fictional placeholder</w:t></w:r></w:p></w:sdtContent></w:sdt>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${controls.join('')}<w:p><w:r><w:t>Fictional text in clear</w:t></w:r></w:p></w:body></w:document>`);
  customXml.forEach((xml, index) => zip.file(`customXml/item${index + 1}.xml`, xml));
  return zip.generateAsync({ type: 'uint8array' });
}

// The demo policy's identifier, as its labels name it.
const DEMO_POLICY_URI = 'urn:oid:2.25.166231019600111174217682845337071458325';

// An ADatP-4774 originator label, as another labelling tool could write it.
function originatorLabel(policy: string, uri: string, classification: string, categories = ''): string {
  return (
    `<slab:originatorConfidentialityLabel xmlns:slab="${LABEL_NAMESPACE}"><slab:ConfidentialityInformation>` +
    `<slab:PolicyIdentifier URI="${uri}">${policy}</slab:PolicyIdentifier><slab:Classification>${classification}</slab:Classification>${categories}` +
    '</slab:ConfidentialityInformation></slab:originatorConfidentialityLabel>'
  );
}

// An ADatP-4778.2 binding of a document label to the main document part,
// unsigned, as another labelling tool could write it.
function bindingOf(labelXml: string): string {
  return (
    `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"><mb:MetadataBindingContainer><mb:MetadataBinding Id="mb-document">` +
    `<mb:Metadata>${labelXml}</mb:Metadata><mb:DataReference URI="pack:///word/document.xml"/>` +
    '</mb:MetadataBinding></mb:MetadataBindingContainer></mb:BindingInformation>'
  );
}

// A package with one more Custom XML part, of the given name, related from
// the main document as ECMA-376 Part 1 §15.2.5 requires.
async function withRelatedCustomXml(docx: Uint8Array, part: string, xml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  zip.file(part, xml);
  const relationships = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file('word/_rels/document.xml.rels', relationships.replace('</Relationships>', `<Relationship Id="rIdLabels" Type="${CUSTOM_XML_RELATIONSHIP}" Target="../${part}"/></Relationships>`));
  return zip.generateAsync({ type: 'uint8array' });
}

// The reason a refusal gives, undefined for another answer.
function reasonOf(json: unknown): unknown {
  return typeof json === 'object' && json !== null && 'reason' in json ? json.reason : undefined;
}

describe('the preparation of an uploaded document', () => {
  let server: FastifyInstance;
  let keys = '';
  let certificate = '';

  before(async () => {
    keys = await mkdtemp(path.join(tmpdir(), 'upload-keys-'));
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(keys, 'signer.key')]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(keys, 'signer.key'), '-out', path.join(keys, 'signer.pem'), '-days', '30', '-subj', '/CN=Fictional signer']);
    certificate = await readFile(path.join(keys, 'signer.pem'), 'utf8');
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      labelMappingFile: DEMO_LABEL_MAPPING,
      bindingSignature: { secret: SECRET, signer: { privateKey: await readFile(path.join(keys, 'signer.key'), 'utf8'), certificate } },
      now: () => new Date('2026-09-29T08:00:00.000Z'),
    });
  });
  after(async () => {
    await server.close();
    await rm(keys, { recursive: true, force: true });
  });

  async function prepared(body: Uint8Array, query: string, secret: string | null = SECRET): Promise<{ statusCode: number; json: unknown; docx: Uint8Array | null }> {
    const response = await server.inject({
      method: 'POST',
      url: `/uploads/prepare${query}`,
      headers: { 'content-type': DOCX_TYPE, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
      payload: Buffer.from(body),
    });
    const isDocx = response.headers['content-type'] === DOCX_TYPE;
    return { statusCode: response.statusCode, json: isDocx ? null : response.json(), docx: isDocx ? new Uint8Array(response.rawPayload) : null };
  }

  function base(code: string): string {
    return `?base=${encodeURIComponent(code)}`;
  }

  // The package as the portal stores it once the signing route has signed it.
  async function signedAndStored(docx: Uint8Array): Promise<{ stored: Uint8Array; bindingXml: string }> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(docx),
    });
    assert.equal(response.statusCode, 200);
    const answer: unknown = response.json();
    const written = typeof answer === 'object' && answer !== null && 'signed' in answer && 'parts' in answer ? [answer.signed, ...(Array.isArray(answer.parts) ? answer.parts : [])] : [];
    const zip = await JSZip.loadAsync(docx);
    let bindingXml = '';
    for (const part of written) {
      const name: unknown = typeof part === 'object' && part !== null && 'part' in part ? part.part : null;
      const xml: unknown = typeof part === 'object' && part !== null && 'xml' in part ? part.xml : null;
      assert.ok(typeof name === 'string' && typeof xml === 'string');
      zip.file(name, xml);
      if (xml.includes(BINDING_NAMESPACE)) {
        bindingXml = xml;
      }
    }
    return { stored: await zip.generateAsync({ type: 'uint8array' }), bindingXml };
  }

  // The Custom XML parts of a package, by the namespace of their root.
  async function customXmlParts(docx: Uint8Array): Promise<Map<string, { part: string; root: Element }>> {
    const zip = await JSZip.loadAsync(docx);
    const parts = new Map<string, { part: string; root: Element }>();
    for (const part of Object.keys(zip.files).filter((name) => /^customXml\/item\d+\.xml$/.test(name))) {
      const root = new DOMParser().parseFromString((await zip.file(part)?.async('string')) ?? '', 'text/xml').documentElement;
      if (root !== null) {
        parts.set(root.namespaceURI ?? '', { part, root });
      }
    }
    return parts;
  }

  for (const [kind, body, reason] of [
    ['a file that is no ZIP package', new TextEncoder().encode('Not a document at all'), 'not-a-package'],
    ['a file that Purview encrypted', compoundFile(['\u0006DataSpaces', 'DRMEncryptedDataSpace', 'EncryptedPackage']), 'rights-management'],
    ['a file that a password protects', compoundFile(['EncryptionInfo', 'EncryptedPackage']), 'password'],
    ['another compound file, such as a legacy .doc', compoundFile(['WordDocument']), 'compound-file'],
  ] as const) {
    it(`refuses ${kind}, and says so`, async () => {
      const { statusCode, json } = await prepared(body, base(DIFFUSION_RESTREINTE));

      assert.equal(statusCode, 422);
      assert.equal(reasonOf(json), reason);
    });
  }

  it('refuses a ZIP package without a WordprocessingML main document', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="txt" ContentType="text/plain"/></Types>');
    zip.file('notes.txt', 'Fictional notes');

    const { statusCode, json } = await prepared(await zip.generateAsync({ type: 'uint8array' }), base(DIFFUSION_RESTREINTE));

    assert.equal(statusCode, 422);
    assert.equal(reasonOf(json), 'not-a-document');
  });

  it('refuses a base label that the security policy does not know', async () => {
    const { statusCode, json } = await prepared(await minimalDocx(), base('DEMO-FR:7'));

    assert.equal(statusCode, 422);
    assert.equal(reasonOf(json), 'unknown-label');
  });

  for (const [kind, query] of [
    ['no base label', ''],
    ['two base labels', `${base(DIFFUSION_RESTREINTE)}&base=${encodeURIComponent(DIFFUSION_RESTREINTE)}`],
  ] as const) {
    it(`refuses a request with ${kind}`, async () => {
      const { statusCode } = await prepared(await minimalDocx(), query);

      assert.equal(statusCode, 400);
    });
  }

  it('refuses a file whose portion labels in clear designate no label', async () => {
    const { statusCode, json } = await prepared(await minimalDocx(['{"id":"p1","label":"DEMO-FR:9"}']), base(DIFFUSION_RESTREINTE));

    assert.equal(statusCode, 422);
    assert.equal(reasonOf(json), 'portion-labels');
  });

  it('refuses a file with several document label bindings, which the signature could not replace', async () => {
    const binding = `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}"/>`;

    const { statusCode, json } = await prepared(await minimalDocx([], [binding, binding]), base(DIFFUSION_RESTREINTE));

    assert.equal(statusCode, 422);
    assert.equal(reasonOf(json), 'several-bindings');
  });

  it('refuses a file whose document label binding is not well-formed XML', async () => {
    const { statusCode, json } = await prepared(await minimalDocx([], [`<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}">`]), base(DIFFUSION_RESTREINTE));

    assert.equal(statusCode, 422);
    assert.equal(reasonOf(json), 'malformed-binding');
  });

  it('refuses a caller without the secret it shares with the portal', async () => {
    const { statusCode } = await prepared(await minimalDocx(), base(DIFFUSION_RESTREINTE), null);

    assert.equal(statusCode, 403);
  });

  it('writes the base label part and the binding of an unlabelled DOCX, as the panel writes them', async () => {
    const { statusCode, docx } = await prepared(new Uint8Array(await readFile(TEMPLATE)), base(DIFFUSION_RESTREINTE));

    assert.equal(statusCode, 200);
    assert.ok(docx !== null);
    const parts = await customXmlParts(docx);
    const baseLabel = parts.get(DOCUMENT_NAMESPACE);
    assert.deepEqual([baseLabel?.root.getAttribute('base'), baseLabel?.root.getAttribute('label')], [DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE]);
    assert.ok(parts.has(BINDING_NAMESPACE));
    // Each part is a Custom XML part of the main document, with its properties.
    const zip = await JSZip.loadAsync(docx);
    const elements = async (part: string, localName: string): Promise<Element[]> =>
      Array.from(new DOMParser().parseFromString((await zip.file(part)?.async('string')) ?? '<none/>', 'text/xml').getElementsByTagName(localName));
    const documentRelationships = await elements('word/_rels/document.xml.rels', 'Relationship');
    const overrides = await elements('[Content_Types].xml', 'Override');
    for (const { part } of parts.values()) {
      const item = path.basename(part);
      const properties = `customXml/${item.replace('item', 'itemProps')}`;
      assert.ok(documentRelationships.some((relationship) => relationship.getAttribute('Type') === CUSTOM_XML_RELATIONSHIP && relationship.getAttribute('Target') === `../customXml/${item}`));
      assert.deepEqual((await elements(`customXml/_rels/${item}.rels`, 'Relationship')).map((relationship) => relationship.getAttribute('Target')), [path.basename(properties)]);
      assert.match((await zip.file(properties)?.async('string')) ?? '', /ds:itemID="\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}"/);
      assert.deepEqual(overrides.filter((override) => override.getAttribute('PartName') === `/${properties}`).map((override) => override.getAttribute('ContentType')), [CUSTOM_XML_PROPERTIES_TYPE]);
    }
  });

  it('prepares a package that signs as it is, over the parts it holds, with the document label its portions give', async () => {
    // A DIFFUSION RESTREINTE document with a SPECIAL FRANCE portion, in a
    // package without notes, headers, styles or document properties.
    const { docx } = await prepared(await minimalDocx([JSON.stringify({ id: 'p1', label: SPECIAL_FRANCE })]), base(DIFFUSION_RESTREINTE));
    assert.ok(docx !== null);

    const { stored, bindingXml } = await signedAndStored(docx);

    const verification = await verifyWithXmlsec(stored, bindingXml, certificate);
    assert.equal(verification.status, 0);
    // The document itself, and the custom properties the sensitivity label
    // went to.
    assert.deepEqual([...verification.references].sort(), ['docProps/custom.xml', 'word/document.xml']);
    assert.equal(verification.manifest, '2/2');
    // The demo policy's rule adds the informative category MORE RESTRICTIVE
    // PORTIONS to a base label below one of the portions.
    const label = new DOMParser().parseFromString(bindingXml, 'text/xml');
    assert.deepEqual(
      Array.from(label.getElementsByTagNameNS(LABEL_NAMESPACE, 'Classification')).map((element) => element.textContent),
      ['DIFFUSION RESTREINTE'],
    );
    assert.deepEqual(
      Array.from(label.getElementsByTagNameNS(LABEL_NAMESPACE, 'Category')).map((category) => [category.getAttribute('Type'), category.getAttribute('TagName'), category.textContent?.trim()]),
      [['INFORMATIVE', 'Composition', 'MORE RESTRICTIVE PORTIONS']],
    );
    const custom = (await (await JSZip.loadAsync(stored)).file('docProps/custom.xml')?.async('string')) ?? '';
    assert.match(custom, /MSIP_Label_10000000-0000-4000-8000-000000000002_Enabled/);
  });

it('replaces a binding in whichever Custom XML part holds it', async () => {
    const docx = await withRelatedCustomXml(await minimalDocx(), 'customXml/labels.xml', bindingOf(originatorLabel('DEMO-FR', DEMO_POLICY_URI, 'DIFFUSION RESTREINTE')));

    const { docx: preparedDocx } = await prepared(docx, base(DIFFUSION_RESTREINTE));

    assert.ok(preparedDocx !== null);
    const zip = await JSZip.loadAsync(preparedDocx);
    const bindings = [];
    for (const name of Object.keys(zip.files).filter((file) => file.startsWith('customXml/') && !file.includes('_rels') && !file.includes('itemProps'))) {
      if (((await zip.file(name)?.async('string')) ?? '').includes(BINDING_NAMESPACE)) {
        bindings.push(name);
      }
    }
    assert.deepEqual(bindings, ['customXml/labels.xml']);
  });
});
