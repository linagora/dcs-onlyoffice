import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';

const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';
const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';

export interface XmlsecVerification {
  status: number | null;
  // "Manifests References (ok/all)", as xmlsec1 reports it.
  manifest: string | null;
  // The package parts the signature's Manifest references.
  references: string[];
}

// Verifies a signed binding with xmlsec1, the independent verifier, against a
// certificate, with the package parts its Manifest references mapped to their
// pack:/// addresses. `alter` may change the extracted parts first.
export async function verifyWithXmlsec(
  docx: Uint8Array,
  bindingXml: string,
  certificate: string,
  alter: (directory: string) => Promise<void> = async () => {},
): Promise<XmlsecVerification> {
  const directory = await mkdtemp(path.join(tmpdir(), 'binding-parts-'));
  try {
    const zip = await JSZip.loadAsync(docx);
    const binding = new DOMParser().parseFromString(bindingXml, 'text/xml');
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
    await writeFile(path.join(directory, 'binding.xml'), bindingXml);
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
    return { status: result.status, manifest: report?.[1] ?? null, references: uris.map((uri) => uri.replace('pack:///', '')) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
