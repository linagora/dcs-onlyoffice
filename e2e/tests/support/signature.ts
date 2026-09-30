import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { expect } from '@playwright/test';
import JSZip from 'jszip';
import { deploymentSetting } from './deployment.ts';
import { BINDING_NAMESPACE, SIGNATURE_NAMESPACE } from './docx.ts';

export interface XmlsecVerification {
  status: number | null;
  // "Manifests References (ok/all)", as xmlsec1 reports it.
  manifest: string | null;
}

// What the portal logs when it serves, to the Document Server or for a
// download, a stored file whose parts changed since signing.
export function changedSinceSigning(servedTo: 'document-server' | 'download', changedParts: string[]): unknown {
  return expect.objectContaining({ servedTo, reason: 'Parts changed since signing', changedParts });
}

// What the portal logs when it serves a stored file whose signature holds
// over unchanged parts but names another document, or none, or is not the
// latest it stored for the document.
export function signatureMismatch(servedTo: 'document-server' | 'download', reason: string): unknown {
  return expect.objectContaining({ servedTo, reason, changedParts: [] });
}

// The demo certificate init-env.sh generated, as deploy/.env holds it.
export function demoCertificate(): string {
  return Buffer.from(deploymentSetting('BINDING_SIGNING_CERTIFICATE'), 'base64').toString('utf8');
}

// Verifies the signature of a DOCX package's document label binding with
// xmlsec1, the independent verifier, against a certificate: xmlsec1 exits
// with 0 when the signature and the references of its SignedInfo hold, and
// reports how many of the package parts its Manifest references still match.
export async function verifyBindingSignature(docx: Buffer, certificate: string): Promise<XmlsecVerification> {
  const directory = await mkdtemp(path.join(tmpdir(), 'binding-'));
  try {
    const zip = await JSZip.loadAsync(docx);
    let binding: string | null = null;
    for (const name of Object.keys(zip.files).filter((file) => /^customXml\/item\d+\.xml$/.test(file))) {
      const xml = (await zip.file(name)?.async('string')) ?? '';
      const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
      if (root?.namespaceURI === BINDING_NAMESPACE && root.localName === 'BindingInformation') {
        binding = xml;
      }
    }
    if (binding === null) {
      throw new Error('The package holds no binding');
    }
    const manifestReferences = Array.from(new DOMParser().parseFromString(binding, 'text/xml').getElementsByTagNameNS(SIGNATURE_NAMESPACE, 'Manifest'))
      .flatMap((manifest) => Array.from(manifest.getElementsByTagNameNS(SIGNATURE_NAMESPACE, 'Reference')))
      .map((reference) => reference.getAttribute('URI') ?? '');
    const maps: string[] = [];
    for (const uri of manifestReferences) {
      // Percent-encoded characters, such as the brackets of
      // [Content_Types].xml, decoded.
      const name = decodeURIComponent(uri.replace('pack:///', ''));
      const target = path.join(directory, 'parts', name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, (await zip.file(name)?.async('uint8array')) ?? new Uint8Array());
      // xmlsec1 looks an address up decoded, then as written.
      for (const address of new Set([`pack:///${name}`, uri])) {
        maps.push(`--url-map:${address}`, target);
      }
    }
    await writeFile(path.join(directory, 'binding.xml'), binding);
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
        '--id-attr:Id',
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
