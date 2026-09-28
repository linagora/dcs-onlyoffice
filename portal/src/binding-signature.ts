import type { FastifyBaseLogger } from 'fastify';
import JSZip from 'jszip';
import { DOCX_CONTENT_TYPE } from './documents.ts';

const SIGNATURE_TIMEOUT_MS = 30_000;

interface SignatureAnswer {
  signed: { part: string; xml: string } | null;
  replacement: { before: string | null; after: string } | null;
}

// Has the policy service sign the document label's binding of each file the
// portal is about to store (ADR 0004). The policy service first computes the
// document label again from the labels in clear, and replaces a different
// one, which the portal logs. A file whose binding cannot be signed is stored
// unsigned, and the failure logged: a save is never lost.
export class BindingSignatures {
  #policyUrl: string;
  #secret: string;
  #log: FastifyBaseLogger;

  constructor(policyInternalUrl: string, secret: string, log: FastifyBaseLogger) {
    this.#policyUrl = policyInternalUrl;
    this.#secret = secret;
    this.#log = log;
  }

  async signed(docx: Uint8Array, documentId: string): Promise<Uint8Array> {
    let answer: SignatureAnswer;
    try {
      answer = await this.#ask(docx);
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
    zip.file(answer.signed.part, answer.signed.xml);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  async #ask(docx: Uint8Array): Promise<SignatureAnswer> {
    const response = await fetch(new URL('/bindings/sign', this.#policyUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#secret}`, 'content-type': DOCX_CONTENT_TYPE },
      body: docx,
      signal: AbortSignal.timeout(SIGNATURE_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    const answer = response.ok ? readSignatureAnswer(body) : null;
    if (answer === null) {
      const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'no signed binding';
      throw new Error(`The policy service answered ${response.status}: ${reason}`);
    }
    return answer;
  }
}

function readSignatureAnswer(body: unknown): SignatureAnswer | null {
  if (typeof body !== 'object' || body === null || !('signed' in body) || !('replacement' in body)) {
    return null;
  }
  const { signed, replacement } = body;
  const signedPart =
    typeof signed === 'object' && signed !== null && 'part' in signed && typeof signed.part === 'string' && 'xml' in signed && typeof signed.xml === 'string'
      ? { part: signed.part, xml: signed.xml }
      : null;
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
  return { signed: signedPart, replacement: replaced };
}
