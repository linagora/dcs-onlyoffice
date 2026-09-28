import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { deploymentSetting } from './deployment.ts';
import { BINDING_NAMESPACE, SIGNATURE_NAMESPACE } from './docx.ts';

export interface XmlsecVerification {
  status: number | null;
  // "Manifests References (ok/all)", as xmlsec1 reports it.
  manifest: string | null;
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
      const name = uri.replace('pack:///', '');
      const target = path.join(directory, 'parts', name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, (await zip.file(name)?.async('uint8array')) ?? new Uint8Array());
      maps.push(`--url-map:${uri}`, target);
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
