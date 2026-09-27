import JSZip from 'jszip';
import type { PortionPart } from './docx.ts';

export interface EnvelopeAssertion {
  type: string | null;
  // The statement's value: the portion label's XML.
  statement: string | null;
}

export interface EnvelopeManifest {
  keyAccessUrls: string[];
  assertions: EnvelopeAssertion[];
}

// Reads the manifest of the ZTDF archive that a portion part holds.
export async function envelopeManifest(part: PortionPart): Promise<EnvelopeManifest> {
  const zip = await JSZip.loadAsync(Buffer.from(part.content, 'base64'));
  const manifest: unknown = JSON.parse((await zip.file('0.manifest.json')?.async('string')) ?? 'null');
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('The envelope holds no manifest');
  }
  const information = field(manifest, 'encryptionInformation');
  const keyAccess = arrayField(information, 'keyAccess');
  return {
    keyAccessUrls: keyAccess.map((entry) => stringField(entry, 'url')).filter((url): url is string => url !== null),
    assertions: arrayField(manifest, 'assertions').map((assertion) => ({
      type: stringField(assertion, 'type'),
      statement: stringField(field(assertion, 'statement'), 'value'),
    })),
  };
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value ? (value as Record<string, unknown>)[name] : null; // SAFETY: object checked just before
}

function arrayField(value: unknown, name: string): unknown[] {
  const found = field(value, name);
  return Array.isArray(found) ? found : [];
}

function stringField(value: unknown, name: string): string | null {
  const found = field(value, name);
  return typeof found === 'string' ? found : null;
}
