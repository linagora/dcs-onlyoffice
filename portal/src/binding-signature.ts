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
type BindingVerification =
  | { status: 'valid' }
  | { status: 'altered'; reason: string; changedParts: string[] }
  | { status: 'unsigned' }
  | { status: 'unlabelled' };

// Where the portal serves a stored file.
export type ServedTo = 'document-server' | 'download';

// Has the policy service sign the document label's binding of each file the
// portal is about to store (ADR 0004), and check it whenever the portal
// serves a stored file. The policy service first computes the document label
// again from the labels in clear, and replaces a different one, which the
// portal logs. A file whose binding cannot be signed is stored unsigned, and
// the failure logged: a save is never lost.
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
    let answer: SignatureAnswer;
    try {
      answer = await this.#ask('/bindings/sign', docx, readSignatureAnswer, headers);
    } catch (error: unknown) {
      this.#log.error({ documentId, err: error }, 'The binding of a save could not be signed');
      return docx;
    }
    if (answer.replacement !== null) {
      this.#log.warn({ documentId, ...answer.replacement }, 'Document label replaced at save');
    }
    if (answer.signed === null) {
      return docx;
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
    const response = await fetch(new URL(route, this.#policyUrl), {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${this.#secret}`, 'content-type': DOCX_CONTENT_TYPE },
      body: docx,
      signal: AbortSignal.timeout(SIGNATURE_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    const answer = response.ok ? read(body) : null;
    if (answer === null) {
      const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'an unexpected answer';
      throw new Error(`The policy service answered ${response.status}: ${reason}`);
    }
    return answer;
  }
}

function readVerification(body: unknown): BindingVerification | null {
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    return null;
  }
  if (body.status === 'valid' || body.status === 'unsigned' || body.status === 'unlabelled') {
    return { status: body.status };
  }
  if (body.status !== 'altered' || !('reason' in body) || typeof body.reason !== 'string' || !('changedParts' in body) || !Array.isArray(body.changedParts)) {
    return null;
  }
  const changedParts: unknown[] = body.changedParts;
  return changedParts.every((part): part is string => typeof part === 'string') ? { status: 'altered', reason: body.reason, changedParts } : null;
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
