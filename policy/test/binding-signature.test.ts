import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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

interface Signed {
  part: string;
  xml: string;
}

interface Verification {
  status: number | null;
  // "Manifests References (ok/all)", as xmlsec1 reports it.
  manifest: string | null;
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

  // A demo key and its self-signed certificate, as init-env.sh makes them.
  before(async () => {
    keys = await mkdtemp(path.join(tmpdir(), 'binding-keys-'));
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(keys, 'key.pem')]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(keys, 'key.pem'), '-out', path.join(keys, 'certificate.pem'), '-days', '30', '-subj', '/CN=Fictional test signer']);
    certificate = await readFile(path.join(keys, 'certificate.pem'), 'utf8');
    server = await buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      bindingSignature: { secret: SECRET, signer: { privateKey: await readFile(path.join(keys, 'key.pem'), 'utf8'), certificate } },
      now: () => NOW,
    });
  });
  after(async () => {
    await server.close();
    await rm(keys, { recursive: true, force: true });
  });

  // The demo template, labelled: its base label, and a binding that the
  // policy service computed for `bindingLabel` over its bindable parts, which
  // `alter` may change.
  async function labelledDocument(
    base: string,
    bindingLabel: string,
    { extraParts = [], alter = (xml) => xml }: { extraParts?: string[]; alter?: (xml: string) => string } = {},
  ): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await readFile(TEMPLATE));
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

  async function sign(docx: Uint8Array, secret: string | null = SECRET): Promise<{ statusCode: number; body: unknown }> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': DOCX_TYPE, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
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

  // Verifies a signed binding with xmlsec1, the independent verifier, against
  // the certificate, with the package parts its Manifest references mapped to
  // their pack:/// addresses. `alter` may change the extracted parts first.
  async function verify(docx: Uint8Array, signed: Signed, alter: (directory: string) => Promise<void> = async () => {}): Promise<Verification> {
    const directory = await mkdtemp(path.join(tmpdir(), 'binding-parts-'));
    try {
      const zip = await JSZip.loadAsync(docx);
      const binding = new DOMParser().parseFromString(signed.xml, 'text/xml');
      const uris = Array.from(binding.getElementsByTagNameNS(SIGNATURE_NAMESPACE, 'Manifest'))
        .flatMap((manifest) => Array.from(manifest.getElementsByTagNameNS(SIGNATURE_NAMESPACE, 'Reference')))
        .map((reference) => reference.getAttribute('URI') ?? '');
      const maps: string[] = [];
      for (const uri of uris) {
        const name = uri.replace('pack:///', '');
        const target = path.join(directory, 'parts', name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, (await zip.file(name)?.async('uint8array')) ?? new Uint8Array());
        maps.push(`--url-map:${uri}`, target);
      }
      await alter(path.join(directory, 'parts'));
      await writeFile(path.join(directory, 'binding.xml'), signed.xml);
      await writeFile(path.join(directory, 'certificate.pem'), certificate);
      // xmlsec1 1.3 prints its Manifest report only when verbose; 1.2 always
      // does, and knows no --verbose.
      const verbose = /xmlsec1 1\.2\./.test(execFileSync('xmlsec1', ['--version'], { encoding: 'utf8' })) ? [] : ['--verbose'];
      const result = spawnSync(
        'xmlsec1',
        [
          '--verify',
          ...verbose,
          '--trusted-pem',
          path.join(directory, 'certificate.pem'),
          `--id-attr:Id`,
          `${BINDING_NAMESPACE}:MetadataBinding`,
          '--enabled-reference-uris',
          'same-doc,remote',
          ...maps,
          path.join(directory, 'binding.xml'),
        ],
        { encoding: 'utf8' },
      );
      const report = /Manifests References \(ok\/all\): (\d+\/\d+)/.exec(`${result.stdout}${result.stderr}`);
      return { status: result.status, manifest: report?.[1] ?? null };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const verification = await verify(docx, signed);
    const count = bindableParts(await JSZip.loadAsync(docx)).length;
    assert.deepEqual(verification, { status: 0, manifest: `${count}/${count}` });
  });

  it('gives a binding that a part changed after signing no longer matches', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE);
    const signed = signedOf((await sign(docx)).body);

    const verification = await verify(docx, signed, async (parts) => {
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
    assert.deepEqual(await verify(docx, signed), { status: 0, manifest: `${count}/${count}` });
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

  it('refuses a binding that references a part the package lacks', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE, { extraParts: ['word/media/image9.png'] });

    const { statusCode, body } = await sign(docx);

    assert.equal(statusCode, 422);
    assert.deepEqual(body, { error: 'The binding references parts the package lacks: word/media/image9.png' });
  });

  it('leaves a document without a binding unsigned', async () => {
    const { statusCode, body } = await sign(new Uint8Array(await readFile(TEMPLATE)));
    assert.equal(statusCode, 200);
    assert.deepEqual(body, { signed: null, replacement: null });
  });

  it('answers only the holder of the shared secret', async () => {
    const docx = await labelledDocument(DIFFUSION_RESTREINTE, DIFFUSION_RESTREINTE);
    assert.equal((await sign(docx, null)).statusCode, 403);
    assert.equal((await sign(docx, 'not-the-secret')).statusCode, 403);
  });
});
