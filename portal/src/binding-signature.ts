import type { FastifyBaseLogger } from 'fastify';
import JSZip from 'jszip';
import { DOCX_CONTENT_TYPE } from './documents.ts';

const SIGNATURE_TIMEOUT_MS = 30_000;
const STORED_CUSTOM_PROPERTIES_HEADER = 'x-stored-custom-properties';
// Beyond this, once encoded, a header could exceed what the policy service
// accepts.
const STORED_CUSTOM_PROPERTIES_LIMIT = 8 * 1024;
// The portal stores what ONLYOFFICE saves, which keeps the custom properties
// in this part.
const CUSTOM_PROPERTIES_PART = 'docProps/custom.xml';

interface WrittenPart {
  part: string;
  xml: string;
}

interface SignatureAnswer {
  signed: WrittenPart | null;
  // The other parts the policy service wrote, such as the custom properties
  // that hold the sensitivity label (ADR 0005).
  parts: WrittenPart[];
  replacement: { before: string | null; after: string } | null;
}

// What the policy service finds in a stored file: a binding whose signature
// holds, one that no longer matches it, one without a signature, or no labels.
type BindingVerification = (
  | { status: 'valid' }
  | { status: 'altered'; reason: string; changedParts: string[] }
  | { status: 'unsigned' }
  | { status: 'unlabelled' }
) & {
  // A Sensitivity Label Information part, which the signature does not cover.
  labelInformationPart: string | null;
};

// Where the portal serves a stored file.
export type ServedTo = 'document-server' | 'download';

// The label an uploaded file carries, and where it comes from: the
// platform's base label part or an ADatP-4778 binding.
export interface CarriedLabel {
  code: string;
  source: 'base-label' | 'binding';
}

// What the policy service reads in an uploaded file: the label it carries,
// null for none, and whether its binding signature matched the platform's
// certificate.
export interface UploadReading {
  label: CarriedLabel | null;
  signature: 'matched' | 'not-matched' | 'absent';
}

// Why the policy service refuses an uploaded file (422), or could not handle
// it (503), as a message for the person.
export interface UploadRefusal {
  ok: false;
  status: 422 | 503;
  message: string;
}

// Has the policy service sign the document label's binding of each file the
// portal is about to store (ADR 0004), and check it whenever the portal
// serves a stored file. The policy service first computes the document label
// again from the labels in clear, and replaces a different one, which the
// portal logs. A save whose binding cannot be signed is stored unsigned, and
// the failure logged: a save is never lost. An uploaded file, which the
// policy service prepares first, is refused instead: its uploader still has
// it.
export class BindingSignatures {
  #policyUrl: string;
  #secret: string;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, secret: string, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#secret = secret;
    this.#log = log;
  }

  // `stored` is the file as stored before this save: the editor never sees
  // the sensitivity label the policy service writes, so the label's date and
  // action id come from the stored file's custom properties.
  async signed(docx: Uint8Array, documentId: string, stored: Uint8Array | null): Promise<Uint8Array> {
    const headers = await this.#storedPropertiesHeader(stored, documentId);
    return (await this.#signedOrNull(docx, documentId, headers, 'The binding of a save could not be signed')) ?? docx;
  }

  // The label an uploaded file carries, where it comes from, and whether its
  // binding signature matched, or why the policy service refuses the file.
  async readUpload(docx: Uint8Array): Promise<{ ok: true; value: UploadReading } | UploadRefusal> {
    return this.#uploadStep('/uploads/read', docx, async (response) => readUploadReading(await response.json()));
  }

  // An uploaded file with the platform's parts, which the policy service
  // writes as the panel does, or why it refuses the file.
  async preparedUpload(docx: Uint8Array, base: string): Promise<{ ok: true; value: Uint8Array } | UploadRefusal> {
    return this.#uploadStep(`/uploads/prepare?base=${encodeURIComponent(base)}`, docx, async (response) => new Uint8Array(await response.arrayBuffer()));
  }

  // A step of an upload: the policy service's answer, or its refusal, which
  // it explains; a failure is logged.
  async #uploadStep<T>(route: string, docx: Uint8Array, answerOf: (response: Response) => Promise<T | null>): Promise<{ ok: true; value: T } | UploadRefusal> {
    try {
      const response = await this.#post(route, docx);
      if (response.ok) {
        const value = await answerOf(response);
        if (value === null) {
          throw new Error('The policy service gave an unexpected answer');
        }
        return { ok: true, value };
      }
      const body: unknown = await response.json();
      const message: unknown = typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
      if (response.status === 422 && typeof message === 'string') {
        return { ok: false, status: 422, message: `${message}.` };
      }
      throw new Error(`The policy service answered ${response.status}`);
    } catch (error: unknown) {
      this.#log.error({ route: route.split('?', 1)[0], err: error }, 'An uploaded file could not be read or prepared');
      return { ok: false, status: 503, message: 'The policy service could not handle the document. Try again later.' };
    }
  }

  // A prepared upload with its binding signed; null when the policy service
  // could not sign it.
  async signedUpload(docx: Uint8Array, documentId: string): Promise<Uint8Array | null> {
    return this.#signedOrNull(docx, documentId, {}, 'The binding of an upload could not be signed');
  }

  // The file with the parts the policy service wrote, its signed binding
  // among them; null when it signed none, the failure then logged.
  async #signedOrNull(docx: Uint8Array, documentId: string, headers: Record<string, string>, failure: string): Promise<Uint8Array | null> {
    let answer: SignatureAnswer;
    try {
      answer = await this.#ask('/bindings/sign', docx, readSignatureAnswer, headers);
    } catch (error: unknown) {
      this.#log.error({ documentId, err: error }, failure);
      return null;
    }
    if (answer.replacement !== null) {
      this.#log.warn({ documentId, ...answer.replacement }, 'Document label replaced at save');
    }
    if (answer.signed === null) {
      return null;
    }
    const zip = await JSZip.loadAsync(docx);
    for (const written of [...answer.parts, answer.signed]) {
      zip.file(written.part, written.xml);
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  // Checks a stored file being served, aside: it is served all the same. A
  // file that no longer matches its binding's signature is logged, and so is
  // one that holds none, until its next save signs it.
  checkAside(docx: Uint8Array, documentId: string, servedTo: ServedTo): void {
    this.#check(docx, documentId, servedTo).catch((error: unknown) => {
      this.#log.error({ documentId, servedTo, err: error }, 'The signature of a stored file could not be checked');
    });
  }

  async #check(docx: Uint8Array, documentId: string, servedTo: ServedTo): Promise<void> {
    const verification = await this.#ask('/bindings/verify', docx, readVerification);
    if (verification.status === 'altered') {
      const { reason, changedParts } = verification;
      this.#log.warn({ documentId, servedTo, reason, changedParts }, 'Stored file no longer matches its signature');
    } else if (verification.status === 'unsigned') {
      this.#log.info({ documentId, servedTo }, 'Stored file unsigned');
    }
    // The platform never writes one (ADR 0005): it came from outside, and Word
    // could show its label instead of the signed one.
    if (verification.labelInformationPart !== null) {
      this.#log.warn({ documentId, servedTo, part: verification.labelInformationPart }, 'Stored file holds a Sensitivity Label Information part');
    }
  }

  // The header that carries the stored file's custom properties, empty when
  // it has none; no header when they cannot be read or are too large, and the
  // policy service then goes by the saved file.
  async #storedPropertiesHeader(stored: Uint8Array | null, documentId: string): Promise<Record<string, string>> {
    if (stored === null) {
      return {};
    }
    let properties: Uint8Array | null;
    try {
      properties = (await (await JSZip.loadAsync(stored)).file(CUSTOM_PROPERTIES_PART)?.async('uint8array')) ?? null;
    } catch (error: unknown) {
      this.#log.warn({ documentId, err: error }, 'The custom properties of a stored file could not be read');
      return {};
    }
    const encoded = properties === null ? '' : Buffer.from(properties).toString('base64');
    if (encoded.length > STORED_CUSTOM_PROPERTIES_LIMIT) {
      this.#log.warn({ documentId, bytes: properties?.length }, 'The custom properties of a stored file are too large to send');
      return {};
    }
    return { [STORED_CUSTOM_PROPERTIES_HEADER]: encoded };
  }

  async #ask<T>(route: string, docx: Uint8Array, read: (body: unknown) => T | null, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.#post(route, docx, headers);
    const body: unknown = await response.json();
    const answer = response.ok ? read(body) : null;
    if (answer === null) {
      const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'an unexpected answer';
      throw new Error(`The policy service answered ${response.status}: ${reason}`);
    }
    return answer;
  }

  // Sends a package to a route of the policy service that only the portal
  // may call.
  async #post(route: string, docx: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(new URL(route, this.#policyUrl), {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${this.#secret}`, 'content-type': DOCX_CONTENT_TYPE },
      body: docx,
      signal: AbortSignal.timeout(SIGNATURE_TIMEOUT_MS),
    });
  }
}

function readVerification(body: unknown): BindingVerification | null {
  if (typeof body !== 'object' || body === null || !('status' in body) || !('labelInformationPart' in body)) {
    return null;
  }
  const { labelInformationPart } = body;
  if (labelInformationPart !== null && typeof labelInformationPart !== 'string') {
    return null;
  }
  if (body.status === 'valid' || body.status === 'unsigned' || body.status === 'unlabelled') {
    return { status: body.status, labelInformationPart };
  }
  if (body.status !== 'altered' || !('reason' in body) || typeof body.reason !== 'string' || !('changedParts' in body) || !Array.isArray(body.changedParts)) {
    return null;
  }
  const changedParts: unknown[] = body.changedParts;
  return changedParts.every((changed): changed is string => typeof changed === 'string') ? { status: 'altered', reason: body.reason, changedParts, labelInformationPart } : null;
}

function readSignatureAnswer(body: unknown): SignatureAnswer | null {
  if (typeof body !== 'object' || body === null || !('signed' in body) || !('parts' in body) || !('replacement' in body)) {
    return null;
  }
  const { signed, parts, replacement } = body;
  const signedPart = writtenPartOf(signed);
  if (!Array.isArray(parts)) {
    return null;
  }
  const writtenParts: WrittenPart[] = [];
  for (const part of parts as unknown[]) {
    const written = writtenPartOf(part);
    if (written === null) {
      return null;
    }
    writtenParts.push(written);
  }
  const replaced =
    typeof replacement === 'object' &&
    replacement !== null &&
    'before' in replacement &&
    (replacement.before === null || typeof replacement.before === 'string') &&
    'after' in replacement &&
    typeof replacement.after === 'string'
      ? { before: replacement.before, after: replacement.after }
      : null;
  if ((signed !== null && signedPart === null) || (replacement !== null && replaced === null)) {
    return null;
  }
  return { signed: signedPart, parts: writtenParts, replacement: replaced };
}

function writtenPartOf(value: unknown): WrittenPart | null {
  return typeof value === 'object' && value !== null && 'part' in value && typeof value.part === 'string' && 'xml' in value && typeof value.xml === 'string'
    ? { part: value.part, xml: value.xml }
    : null;
}

function readUploadReading(body: unknown): UploadReading | null {
  if (typeof body !== 'object' || body === null || !('label' in body) || !('signature' in body)) {
    return null;
  }
  const { label, signature } = body;
  if (signature !== 'matched' && signature !== 'not-matched' && signature !== 'absent') {
    return null;
  }
  if (label === null) {
    return { label: null, signature };
  }
  const code: unknown = typeof label === 'object' && 'code' in label ? label.code : null;
  const source: unknown = typeof label === 'object' && label !== null && 'source' in label ? label.source : null;
  return typeof code === 'string' && (source === 'base-label' || source === 'binding') ? { label: { code, source }, signature } : null;
}
