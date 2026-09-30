import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import * as x509 from '@peculiar/x509';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { buildPolicyServer } from '../src/server.ts';

x509.cryptoProvider.set(webcrypto);

const DEMO_SPIFS = path.join(import.meta.dirname, '..', '..', 'deploy', 'spif');
const TEMPLATE = path.join(import.meta.dirname, '..', '..', 'deploy', 'demo', 'documents', 'exercise-northwind.docx');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SECRET = 'fictional-binding-signature-secret';
const NOW = new Date('2026-09-28T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
// The demo SPIF's code of DIFFUSION RESTREINTE.
const DIFFUSION_RESTREINTE = 'DEMO-FR:2';
// ECDSA P-256 with SHA-256, as ADatP-4778.2 requires of signatures.
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

// A certificate authority: its keys, its private key as PEM, and its
// self-signed certificate.
interface Authority {
  keys: webcrypto.CryptoKeyPair;
  privateKey: string;
  certificate: x509.X509Certificate;
  pem: string;
}

// A signing key and the certificate an authority issued for it, as PEM.
interface Signer {
  privateKey: string;
  certificate: string;
  serialNumber: string;
}

async function authority(name: string): Promise<Authority> {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${name}`,
    notBefore: new Date(NOW.getTime() - 365 * DAY_MS),
    notAfter: new Date(NOW.getTime() + 3650 * DAY_MS),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
  });
  const privateKey = x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY');
  return { keys, privateKey, certificate, pem: certificate.toString('pem') };
}

// A signing certificate the authority issues, valid from a month before the
// tests' clock to a year after it unless told otherwise.
async function issued(by: Authority, serialNumber: string, validity: { notBefore?: Date; notAfter?: Date } = {}): Promise<Signer> {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: `CN=Fictional binding signer ${serialNumber}`,
    issuer: by.certificate.subject,
    notBefore: validity.notBefore ?? new Date(NOW.getTime() - 30 * DAY_MS),
    notAfter: validity.notAfter ?? new Date(NOW.getTime() + 365 * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: by.keys.privateKey,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)],
  });
  const privateKey = x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY');
  return { privateKey, certificate: certificate.toString('pem'), serialNumber };
}

// A certificate revocation list the authority signs, made by OpenSSL's
// certificate authority rather than by the library that the service reads
// lists with.
async function revocationList(by: Authority, serialNumbers: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'revocation-list-'));
  try {
    await writeFile(path.join(directory, 'authority.key'), by.privateKey);
    await writeFile(path.join(directory, 'authority.pem'), by.pem);
    // The authority's database holds the revoked certificates, with a far
    // expiry and the tests' clock as their revocation time.
    await writeFile(path.join(directory, 'index.txt'), serialNumbers.map((serialNumber) => `R\t491231235959Z\t260928090000Z\t${serialNumber}\tunknown\t/CN=Revoked\n`).join(''));
    await writeFile(path.join(directory, 'crlnumber'), '01\n');
    await writeFile(path.join(directory, 'ca.cnf'), '[ ca ]\ndefault_ca = test\n[ test ]\ndatabase = index.txt\ncrlnumber = crlnumber\ndefault_md = sha256\ndefault_crl_days = 30\n');
    execFileSync('openssl', ['ca', '-config', 'ca.cnf', '-gencrl', '-keyfile', 'authority.key', '-cert', 'authority.pem', '-out', 'list.pem'], {
      cwd: directory,
      stdio: 'pipe',
    });
    return await readFile(path.join(directory, 'list.pem'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the trust in a binding signature', () => {
  let demo: Authority;
  let other: Authority;

  before(async () => {
    demo = await authority('Fictional demo signing authority');
    other = await authority('Fictional other authority');
  });

  // A policy service that signs with `signer`, and trusts the demo authority
  // unless told otherwise, on the tests' clock unless given another.
  async function policyService(signer: Signer, trust: { anchors?: string; revocationLists?: string } = {}, now: () => Date = () => NOW): Promise<FastifyInstance> {
    return buildPolicyServer({
      spifDirectory: DEMO_SPIFS,
      bindingSignature: {
        secret: SECRET,
        signer: { privateKey: signer.privateKey, certificate: signer.certificate },
        trustAnchors: trust.anchors ?? demo.pem,
        revocationLists: trust.revocationLists ?? '',
      },
      now,
    });
  }

  // The template labelled DIFFUSION RESTREINTE, with the binding the panel
  // writes, signed by `server` as the portal stores it.
  async function signedDocument(server: FastifyInstance): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await readFile(TEMPLATE));
    const computed = await server.inject({ method: 'POST', url: '/policies/DEMO-FR/document-label', payload: { base: DIFFUSION_RESTREINTE, portions: [] } });
    assert.equal(computed.statusCode, 200);
    zip.file('customXml/item1.xml', (computed.json() as { xml: string }).xml); // SAFETY: the answer asserted just above
    zip.file('customXml/item2.xml', `<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="${DIFFUSION_RESTREINTE}" label="${DIFFUSION_RESTREINTE}"/>`);
    const docx = await zip.generateAsync({ type: 'uint8array' });
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/sign',
      headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(docx),
    });
    assert.equal(response.statusCode, 200);
    const { signed } = response.json() as { signed: { part: string; xml: string } }; // SAFETY: the status asserted just above
    const stored = await JSZip.loadAsync(docx);
    stored.file(signed.part, signed.xml);
    return stored.generateAsync({ type: 'uint8array' });
  }

  async function verdictOf(server: FastifyInstance, docx: Uint8Array): Promise<unknown> {
    const response = await server.inject({
      method: 'POST',
      url: '/bindings/verify',
      headers: { 'content-type': DOCX_TYPE, authorization: `Bearer ${SECRET}` },
      payload: Buffer.from(docx),
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  }

  function altered(reason: string): unknown {
    return { status: 'altered', reason, changedParts: [], labelInformationPart: null };
  }

  it('finds a file signed before the signing key was rotated valid, since the same authority issued both certificates', async () => {
    const previous = await policyService(await issued(demo, '1001'));
    const docx = await signedDocument(previous);
    await previous.close();

    const after = await policyService(await issued(demo, '1002'));
    assert.deepEqual(await verdictOf(after, docx), { status: 'valid', labelInformationPart: null });
    await after.close();
  });

  it('reports a file whose signing certificate an authority it does not trust issued', async () => {
    const elsewhere = await policyService(await issued(other, '2001'), { anchors: other.pem });
    const docx = await signedDocument(elsewhere);
    await elsewhere.close();

    const server = await policyService(await issued(demo, '2002'));
    assert.deepEqual(await verdictOf(server, docx), altered('The signing certificate is not trusted'));
    await server.close();
  });

  it('reports a file signed with a certificate that its authority revoked', async () => {
    const compromised = await issued(demo, '3001');
    const previous = await policyService(compromised);
    const docx = await signedDocument(previous);
    await previous.close();

    const server = await policyService(await issued(demo, '3002'), { revocationLists: await revocationList(demo, [compromised.serialNumber]) });
    assert.deepEqual(await verdictOf(server, docx), altered('The signing certificate was revoked'));
    await server.close();
  });

  it("reports a file signed outside its certificate's validity", async () => {
    // A certificate that expires the day after the service starts, which
    // signs on the day after that.
    let clock = NOW;
    const expired = await policyService(await issued(demo, '4001', { notAfter: new Date(NOW.getTime() + DAY_MS) }), {}, () => clock);
    clock = new Date(NOW.getTime() + 2 * DAY_MS);
    const docx = await signedDocument(expired);
    await expired.close();

    const server = await policyService(await issued(demo, '4002'));
    assert.deepEqual(await verdictOf(server, docx), altered("The signature was made outside its certificate's validity"));
    await server.close();
  });

  it('refuses to start with a signing certificate that no trusted authority issued or that is not valid yet, or a revocation list that none signed', async () => {
    await assert.rejects(policyService(await issued(other, '5001')), /No trusted authority issued the binding signing certificate/);
    await assert.rejects(policyService(await issued(demo, '5003', { notBefore: new Date(NOW.getTime() + DAY_MS) })), /The binding signing certificate is outside its validity/);
    await assert.rejects(
      policyService(await issued(demo, '5002'), { revocationLists: await revocationList(other, ['5002']) }),
      /No trusted authority signed a binding revocation list/,
    );
  });
});
