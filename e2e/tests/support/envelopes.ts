import JSZip from 'jszip';
import type { PortionPart } from './docx.ts';
import { arrayField, field, stringField, stringsOf } from './json.ts';

export interface EnvelopeAssertion {
  type: string | null;
  // The statement's value: the portion label's XML.
  statement: string | null;
}

// Where the envelope's key is, and how it is wrapped.
export interface KeyAccessObject {
  type: string | null;
  url: string | null;
  // The KAS key the envelope's key is wrapped for.
  kid: string | null;
}

export interface EnvelopeManifest {
  keyAccess: KeyAccessObject[];
  // The FQNs of the attribute values the envelope's policy names.
  dataAttributes: string[];
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
  // The envelope's own access policy, base64-encoded JSON.
  const encodedZtdfPolicy = stringField(information, 'policy');
  const ztdfPolicy: unknown = encodedZtdfPolicy === null ? null : JSON.parse(Buffer.from(encodedZtdfPolicy, 'base64').toString('utf8'));
  return {
    keyAccess: arrayField(information, 'keyAccess').map((keyAccess) => ({
      type: stringField(keyAccess, 'type'),
      url: stringField(keyAccess, 'url'),
      kid: stringField(keyAccess, 'kid'),
    })),
    dataAttributes: stringsOf(arrayField(field(ztdfPolicy, 'body'), 'dataAttributes'), 'attribute'),
    assertions: arrayField(manifest, 'assertions').map((assertion) => ({
      type: stringField(assertion, 'type'),
      statement: stringField(field(assertion, 'statement'), 'value'),
    })),
  };
}
