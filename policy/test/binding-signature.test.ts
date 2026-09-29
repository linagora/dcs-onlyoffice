import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';
import { verifyWithXmlsec } from './xmlsec.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const WORKBOOK_TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind-logistics.xlsx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SECRET = 'fictional-binding-signature-secret';
const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';
const WSU_NAMESPACE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
// ADatP-4778.2 makes exclusive canonicalisation, SHA-384 digests and ECDSA
// with SHA-256 signatures mandatory (Tables 2-2 to 2-4).
const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const SHA384 = 'http://www.w3.org/2001/04/xmldsig-more#sha384';
const ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
const NOW = new Date('2026-09-28T09:00:00.000Z');
// Parts ADatP-4778.2 Tables 5-2 and 5-3 require a whole-document binding to
// reference, when the package holds them.
const BINDABLE_PART = /^(word\/(document|styles|footnotes|endnotes|comments)\.xml|word\/(header|footer)\d*\.xml|word\/media\/.+|docProps\/(core|app|custom)\.xml)$/;
// Codes of the demo SPIF's labels.
const NON_PROTEGE = 'DEMO-FR:1';
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
const SPECIAL_FRANCE = 'DEMO-FR:2/1.1';
// DIFFUSION RESTREINTE with the informative category MORE RESTRICTIVE
// PORTIONS, the document label of a DIFFUSION RESTREINTE document that holds
// more restrictive portions.
const WITH_MORE_RESTRICTIVE_PORTIONS = 'DEMO-FR:2/3.1';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
// The extension in which ONLYOFFICE writes a sheet's user protected ranges.
const USER_PROTECTED_RANGES_EXTENSION = '{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}';

interface Signed {
  part: string;
  xml: string;
}

// What a signed binding declares besides its values.
interface Declarations {
  canonicalization: string[];
  signature: string[];
  digests: string[];
  signingTime: string[];
  certificates: string[];
  metadataBindings: number;
}

describe('the signature of the document label binding', () => {
  let server: FastifyInstance;
  let keys = '';
  let certificate = '';

  // A demo key and its self-signed certificate, as init-env.sh makes them;
  // the other one belongs to another signer.
  before(async () => {
    keys = await mkdtemp(path.join(tmpdir(), 'binding-keys-'));
    for (const name of ['signer', 'other-signer']) {
      execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(keys, `${name}.key`)]);
      execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(keys, `${name}.key`), '-out', path.join(keys, `${name}.pem`), '-days', '30', '-subj', `/CN=Fictional ${name}`]);
    }
    certificate = await readFile(path.join(keys, 'signer.pem'), 'utf8');
    server = await signingServer('signer');
  });
  after(async () => {
    await server.close();
    await rm(keys, { recursive: true, force: true });
  });

  async function signingServer(name: string): Promise<FastifyInstance> {
    return buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      bindingSignature: {
        secret: SECRET,
        signer: { privateKey: await readFile(path.join(keys, `${name}.key`), 'utf8'), certificate: await readFile(path.join(keys, `${name}.pem`), 'utf8') },
      },
      now: () => NOW,
    });
  }

  // A demo template, the text one unless told otherwise, labelled: its base
  // label, and a binding that the policy service computed for `bindingLabel`
  // over its bindable parts, which `alter` may change.
  async function labelledDocument(
    base: string,
    bindingLabel: string,
    { template = TEMPLATE, extraParts = [], alter = (xml) => xml }: { template?: string; extraParts?: string[]; alter?: (xml: string) => string } = {},
  ): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await readFile(template));
    const computed = await server.inject({
      method: 'POST',
      url: '/policies/DEMO-FR/document-label',
      headers: { 'x-user-email': 'alice%40example.org' },
      payload: { base: bindingLabel, portions: [], parts: [...bindableParts(zip), ...extraParts] },
    });
    assert.equal(computed.statusCode, 200);
    zip.file('customXml/item1.xml', alter((computed.json() as { xml: string }).xml)); // SAFETY: the answer asserted just above
    zip.file('customXml/item2.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${base}" label="${bindingLabel}"/>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  function bindableParts(zip: JSZip): string[] {
    return Object.keys(zip.files).filter((name) => BINDABLE_PART.test(name)).sort();
  }

  async function sign(docx: Uint8Array, secret: string | null = SECRET, type: string = DOCX_TYPE): Promise<{ statusCode: number; body: unknown }> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': type, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
      payload: Buffer.from(docx),
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  function signedOf(body: unknown): Signed {
    assert.ok(typeof body === 'object' && body !== null && 'signed' in body, 'expected a signed binding');
    const { signed } = body;
    assert.ok(typeof signed === 'object' && signed !== null && 'part' in signed && 'xml' in signed, 'expected a signed binding');
    assert.ok(typeof signed.part === 'string' && typeof signed.xml === 'string', 'expected a signed binding');
    return { part: signed.part, xml: signed.xml };
  }

  // A package whose binding `signer` signed, as the portal stores it.
  async function signedPackage(docx: Uint8Array, signer: FastifyInstance = server, type: string = DOCX_TYPE): Promise<Uint8Array> {
    const response = await signer.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': type, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(docx),
    });
    const signed = signedOf(response.json());
    const zip = await JSZip.loadAsync(docx);
    zip.file(signed.part, signed.xml);
    return zip.generateAsync({ type: 'uint8array' });
  }

  // A package with one of its parts rewritten.
  async function withChangedPart(docx: Uint8Array, name: string, change: (content: string) => string): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    zip.file(name, change((await zip.file(name)?.async('string')) ?? ''));
    return zip.generateAsync({ type: 'uint8array' });
  }

  // A package with parts added, by name.
  async function withParts(docx: Uint8Array, parts: Record<string, string>): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(docx);
    for (const [name, content] of Object.entries(parts)) {
      zip.file(name, content);
    }
    return zip.generateAsync({ type: 'uint8array' });
  }

  // The policy service's verdict on a package.
  async function verdictOf(docx: Uint8Array, secret: string | null = SECRET, type: string = DOCX_TYPE): Promise<{ statusCode: number; body: unknown }> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/verify',
      headers: { 'content-type': type, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
      payload: Buffer.from(docx),
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  function replacementOf(body: unknown): unknown {
    assert.ok(typeof body === 'object' && body !== null && 'replacement' in body, 'expected a replacement');
    return body.replacement;
  }

  function declarationsOf(xml: string): Declarations {
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const algorithms = (localName: string): string[] =>
      Array.from(document.getElementsByTagNameNS(SIGNATURE_NAMESPACE, localName)).map((element) => element.getAttribute('Algorithm') ?? '');
    const texts = (namespace: string, localName: string): string[] =>
      Array.from(document.getElementsByTagNameNS(namespace, localName)).map((element) => (element.textContent ?? '').replace(/\s/g, ''));
    return {
      canonicalization: algorithms('CanonicalizationMethod'),
      signature: algorithms('SignatureMethod'),
      digests: [...new Set(algorithms('DigestMethod'))],
      signingTime: texts(WSU_NAMESPACE, 'Created'),
      certificates: texts(SIGNATURE_NAMESPACE, 'X509Certificate'),
      metadataBindings: document.getElementsByTagNameNS(BINDING_NAMESPACE, 'MetadataBinding').length,
    };
  }

  it('signs the binding first in its part, as xmlsec1 verifies against the certificate', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE);

    const { statusCode, body } = await sign(docx);

    assert.equal(statusCode, 200);
    const signed = signedOf(body);
    assert.equal(signed.part, 'customXml/item1.xml');
    const root = new DOMParser().parseFromString(signed.xml, 'text/xml').documentElement;
    const first = Array.from(root?.childNodes ?? []).find((node) => node.nodeType === 1);
    assert.equal(`${first?.namespaceURI} ${first?.localName}`, `${SIGNATURE_NAMESPACE} Signature`);
    assert.equal(replacementOf(body), null);
    assert.deepEqual(declarationsOf(signed.xml), {
      canonicalization: [EXCLUSIVE_C14N],
      signature: [ECDSA_SHA256],
      digests: [SHA384],
      signingTime: ['2026-09-28T09:00:00.000Z'],
      certificates: [certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '')],
      metadataBindings: 1,
    });
    const verification = await verifyWithXmlsec(docx, signed.xml, certificate);
    const count = bindableParts(await JSZip.loadAsync(docx)).length;
    assert.deepEqual([verification.status, verification.manifest], [0, `${count}/${count}`]);
  });

  it('gives a binding that a part changed after signing no longer matches', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE);
    const signed = signedOf((await sign(docx)).body);

    const verification = await verifyWithXmlsec(docx, signed.xml, certificate, async (parts) => {
      const document = path.join(parts, 'word', 'document.xml');
      await writeFile(document, `${await readFile(document, 'utf8')}<!-- changed after signing -->`);
    });

    const count = bindableParts(await JSZip.loadAsync(docx)).length;
    assert.equal(verification.manifest, `${count - 1}/${count}`);
  });

  it('replaces a document label the content does not give, and reports it', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, NON_PROTEGE);

    const { statusCode, body } = await sign(docx);

    assert.equal(statusCode, 200);
    assert.deepEqual(replacementOf(body), { before: NON_PROTEGE, after: DIFFUSION_RESTREINTE });
    const signed = signedOf(body);
    assert.match(signed.xml, /<slab:Classification>DIFFUSION RESTREINTE<\/slab:Classification>/);
    const count = bindableParts(await JSZip.loadAsync(docx)).length;
    const verification = await verifyWithXmlsec(docx, signed.xml, certificate);
    assert.deepEqual([verification.status, verification.manifest], [0, `${count}/${count}`]);
  });

  it('writes the binding again from the labels in clear, so that nothing written in it by hand gets signed', async () => {
    const forged = '<mb:MetadataBinding Id="forged"><mb:Metadata>Fictional forged metadata</mb:Metadata></mb:MetadataBinding>';
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, {
      alter: (xml) => xml.replace('</mb:MetadataBindingContainer>', `${forged}</mb:MetadataBindingContainer>`),
    });

    const signed = signedOf((await sign(docx)).body);

    assert.equal(declarationsOf(signed.xml).metadataBindings, 1);
    assert.doesNotMatch(signed.xml, /forged/);
    // The policy service computed the label: it names no originator.
    assert.doesNotMatch(signed.xml, /OriginatorID/);
  });

  it('refuses a package whose base label has no binding', async () => {
    const zip = await JSZip.loadAsync(await readFile(TEMPLATE));
    zip.file('customXml/item1.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${DIFFUSION_RESTREINTE}"/>`);

    const { statusCode, body } = await sign(await zip.generateAsync({ type: 'uint8array' }));

    assert.equal(statusCode, 422);
    assert.deepEqual(body, { error: 'The package has a base label but no document label binding' });
  });

  it('refuses a package with several bindings', async () => {
    const zip = await JSZip.loadAsync(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));
    zip.file('customXml/item3.xml', (await zip.file('customXml/item1.xml')?.async('string')) ?? '');

    const { statusCode, body } = await sign(await zip.generateAsync({ type: 'uint8array' }));

    assert.equal(statusCode, 422);
    assert.deepEqual(body, { error: 'The package holds several document label bindings, where ADatP-4778.2 allows one' });
  });

  it('references the parts the package holds, whatever parts the binding it received named', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, { extraParts: ['word/media/image9.png'] });

    const signed = signedOf((await sign(docx)).body);

    const verification = await verifyWithXmlsec(docx, signed.xml, certificate);
    const present = bindableParts(await JSZip.loadAsync(docx));
    assert.deepEqual([...verification.references].sort(), [...present].sort());
    assert.equal(verification.manifest, `${present.length}/${present.length}`);
  });

  it('references the Tables 5-2 and 5-3 parts a workbook holds, chart styles under both names, as xmlsec1 verifies', async () => {
    const labelled = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, { template: WORKBOOK_TEMPLATE });
    const xlsx = await withParts(labelled, {
      'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      'xl/charts/chart1.xml': '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
      'xl/charts/colors1.xml': '<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle"/>',
      // The chart style part as Microsoft Excel and ONLYOFFICE name it, and
      // as the table does.
      'xl/charts/style1.xml': '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle"/>',
      'xl/charts/styles2.xml': '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle"/>',
      'xl/pivotTables/pivotTable1.xml': '<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      'xl/comments1.xml': '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      'xl/media/image1.png': 'Fictional picture',
      'docProps/custom.xml': '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
      // Parts the tables leave out.
      'xl/theme/theme1.xml': '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>',
      'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
      'xl/threadedComments/threadedComment1.xml': '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"/>',
      'xl/pivotCache/pivotCacheDefinition1.xml': '<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      'xl/tables/table1.xml': '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      'xl/chartsheets/sheet1.xml': '<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    });

    const { statusCode, body } = await sign(xlsx, SECRET, XLSX_TYPE);

    assert.equal(statusCode, 200);
    const verification = await verifyWithXmlsec(xlsx, signedOf(body).xml, certificate);
    assert.deepEqual([...verification.references].sort(), [
      'docProps/app.xml',
      'docProps/core.xml',
      'docProps/custom.xml',
      'xl/charts/chart1.xml',
      'xl/charts/colors1.xml',
      'xl/charts/style1.xml',
      'xl/charts/styles2.xml',
      'xl/comments1.xml',
      'xl/media/image1.png',
      'xl/pivotTables/pivotTable1.xml',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    assert.deepEqual([verification.status, verification.manifest], [0, '15/15']);
  });

  // A DIFFUSION RESTREINTE workbook holding SPECIAL FRANCE portion parts, and
  // a user protected range for each id in `ranges`, as ONLYOFFICE saves them.
  async function workbookWithPortions(ids: string[], ranges: string[]): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, { template: WORKBOOK_TEMPLATE }));
    for (const [index, id] of ids.entries()) {
      zip.file(
        `customXml/item${index + 3}.xml`,
        `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${id}" version="1" label="${SPECIAL_FRANCE}"><dcs:label/><dcs:content encoding="ztdf">RmljdGlvbmFs</dcs:content></dcs:portion>`,
      );
    }
    const userProtectedRanges = ranges.map((id, index) => `<userProtectedRange name="${id}" sqref="F${4 + 3 * index}:G${5 + 3 * index}"></userProtectedRange>`).join('');
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
    zip.file(
      'xl/worksheets/sheet1.xml',
      sheet.replace('</worksheet>', `<extLst><ext uri="${USER_PROTECTED_RANGES_EXTENSION}"><userProtectedRanges>${userProtectedRanges}</userProtectedRanges></ext></extLst></worksheet>`),
    );
    return zip.generateAsync({ type: 'uint8array' });
  }

  it("counts a workbook's portion parts that have a user protected range in its document label", async () => {
    const xlsx = await workbookWithPortions(['portion-with-range', 'portion-without-range'], ['portion-with-range']);

    const { statusCode, body } = await sign(xlsx, SECRET, XLSX_TYPE);

    assert.equal(statusCode, 200);
    assert.deepEqual(replacementOf(body), { before: DIFFUSION_RESTREINTE, after: WITH_MORE_RESTRICTIVE_PORTIONS });
    assert.match(signedOf(body).xml, /MORE RESTRICTIVE PORTIONS/);
  });

  it("leaves a workbook's portion part without a user protected range out of its document label", async () => {
    const xlsx = await workbookWithPortions(['portion-without-range'], ['a-range-without-part']);

    const { statusCode, body } = await sign(xlsx, SECRET, XLSX_TYPE);

    assert.equal(statusCode, 200);
    assert.equal(replacementOf(body), null);
    assert.doesNotMatch(signedOf(body).xml, /MORE RESTRICTIVE PORTIONS/);
  });

  it('finds a workbook whose binding it signed valid, and names its parts changed since signing', async () => {
    const signed = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, { template: WORKBOOK_TEMPLATE }), server, XLSX_TYPE);

    const changed = await withChangedPart(signed, 'xl/worksheets/sheet1.xml', (xml) => `${xml}<!-- changed after signing -->`);

    assert.deepEqual(await verdictOf(signed, SECRET, XLSX_TYPE), { statusCode: 200, body: { status: 'valid', labelInformationPart: null } });
    assert.deepEqual(await verdictOf(changed, SECRET, XLSX_TYPE), {
      statusCode: 200,
      body: { status: 'altered', reason: 'Parts changed since signing', changedParts: ['xl/worksheets/sheet1.xml'], labelInformationPart: null },
    });
  });

  it('leaves a document without a binding unsigned', async () => {
    const { statusCode, body } = await sign(new Uint8Array(await readFile(TEMPLATE)));
    assert.equal(statusCode, 200);
    assert.deepEqual(body, { signed: null, parts: [], replacement: null });
  });

  it('finds a stored package whose binding it signed valid', async () => {
    const docx = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));

    assert.deepEqual(await verdictOf(docx), { statusCode: 200, body: { status: 'valid', labelInformationPart: null } });
  });

  it('names the parts changed since signing', async () => {
    const signed = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));

    const docx = await withChangedPart(signed, 'word/document.xml', (xml) => `${xml}<!-- changed after signing -->`);

    assert.deepEqual(await verdictOf(docx), {
      statusCode: 200,
      body: { status: 'altered', reason: 'Parts changed since signing', changedParts: ['word/document.xml'], labelInformationPart: null },
    });
  });

  it('finds a binding changed since signing, or signed with another key, altered', async () => {
    const signed = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));
    const relabelled = await withChangedPart(signed, 'customXml/item1.xml', (xml) =>
      xml.replace('<slab:Classification>DIFFUSION RESTREINTE</slab:Classification>', '<slab:Classification>NON PROTÉGÉ</slab:Classification>'),
    );
    const otherSigner = await signingServer('other-signer');
    const signedElsewhere = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE), otherSigner);
    await otherSigner.close();

    for (const docx of [relabelled, signedElsewhere]) {
      assert.deepEqual(await verdictOf(docx), {
        statusCode: 200,
        body: { status: 'altered', reason: 'The signature does not hold', changedParts: [], labelInformationPart: null },
      });
    }
  });

  it('finds what the binding holds beside what its signature covers altered', async () => {
    const signed = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));
    const forged =
      '<slab:originatorConfidentialityLabel xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0">' +
      '<slab:ConfidentialityInformation><slab:Classification>NON PROTÉGÉ</slab:Classification></slab:ConfidentialityInformation>' +
      '</slab:originatorConfidentialityLabel>';
    const additions: ((xml: string) => string)[] = [
      (xml) => xml.replace('<X509Data>', `${forged}<X509Data>`),
      (xml) => xml.replace('</Signature>', `<Object>${forged}</Object></Signature>`),
      (xml) => xml.replace('<mb:MetadataBindingContainer>', `<mb:MetadataBindingContainer><mb:Metadata>${forged}</mb:Metadata></mb:MetadataBindingContainer><mb:MetadataBindingContainer>`),
      (xml) => xml.replace('</mb:MetadataBindingContainer>', '</mb:MetadataBindingContainer><mb:DataReference URI="pack:///word/fictional.xml"/>'),
    ];

    for (const add of additions) {
      assert.deepEqual(await verdictOf(await withChangedPart(signed, 'customXml/item1.xml', add)), {
        statusCode: 200,
        body: { status: 'altered', reason: 'The binding holds what its signature does not cover', changedParts: [], labelInformationPart: null },
      });
    }
  });

  it('finds a binding that is no well-formed XML without a DTD altered', async () => {
    const signed = await signedPackage(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE));
    const breakages: ((xml: string) => string)[] = [(xml) => `<!DOCTYPE fictional [<!ENTITY label "NON PROTÉGÉ">]>${xml}`, (xml) => xml.slice(0, -20)];

    for (const breakage of breakages) {
      assert.deepEqual(await verdictOf(await withChangedPart(signed, 'customXml/item1.xml', breakage)), {
        statusCode: 200,
        body: { status: 'altered', reason: 'The binding is not well-formed XML', changedParts: [], labelInformationPart: null },
      });
    }
  });

  it('finds a package whose base label has no binding altered', async () => {
    const zip = await JSZip.loadAsync(await readFile(TEMPLATE));
    zip.file('customXml/item1.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${DIFFUSION_RESTREINTE}"/>`);

    assert.deepEqual(await verdictOf(await zip.generateAsync({ type: 'uint8array' })), {
      statusCode: 200,
      body: { status: 'altered', reason: 'The package has a base label but no document label binding', changedParts: [], labelInformationPart: null },
    });
  });

  it('finds a binding without a signature unsigned, and a package without labels unlabelled', async () => {
    assert.deepEqual(await verdictOf(await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE)), {
      statusCode: 200,
      body: { status: 'unsigned', labelInformationPart: null },
    });
    assert.deepEqual(await verdictOf(new Uint8Array(await readFile(TEMPLATE))), { statusCode: 200, body: { status: 'unlabelled', labelInformationPart: null } });
  });

  it('answers only the holder of the shared secret', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE);
    assert.equal((await sign(docx, null)).statusCode, 403);
    assert.equal((await sign(docx, 'not-the-secret')).statusCode, 403);
    assert.equal((await verdictOf(docx, null)).statusCode, 403);
    assert.equal((await verdictOf(docx, 'not-the-secret')).statusCode, 403);
  });
});
