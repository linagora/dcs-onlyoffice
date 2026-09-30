import type { FastifyBaseLogger } from 'fastify';
import JSZip from 'jszip';
import type { UserIdentity } from './auth/sessions.ts';
import { DOCUMENT_FORMATS, type DocumentFormat, formatOfContentType, type StoredDocument } from './documents.ts';
import { type Journal, journalPerson } from './journal.ts';

const SIGNATURE_TIMEOUT_MS = 30_000;
const STORED_CUSTOM_PROPERTIES_HEADER = 'x-stored-custom-properties';
// The document a file is stored or served as, and the latest signature the
// portal stored for that document.
const DOCUMENT_ID_HEADER = 'x-document-id';
const LATEST_SIGNATURE_HEADER = 'x-latest-signature';
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

// The signed binding, and its signature's value.
interface SignedPart extends WrittenPart {
  signatureValue: string;
}

interface SignatureAnswer {
  signed: SignedPart | null;
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

// The stored document a package is, as the policy service needs to know it.
type DocumentRef = Pick<StoredDocument, 'id' | 'format'>;

// A stored document whose file is being served, with the latest signature
// the portal stored for it when it looked the document up, before it read
// the file.
type CheckedDocument = Pick<StoredDocument, 'id' | 'format' | 'latestSignature'>;

// The reason the policy service gives a file whose signature is not the
// latest the portal sent it.
const NOT_THE_LATEST = 'Not the latest signed version';

// A file to store, and the value of its signature: null when the policy
// service could not sign it.
export interface SignedFile {
  content: Uint8Array;
  signatureValue: string | null;
}

// Where the label an uploaded file carries comes from: the platform's base
// label part, an ADatP-4778 binding, or a sensitivity label that the label
// mapping knows.
const LABEL_SOURCES = ['base-label', 'binding', 'sensitivity-label'] as const;

// The label an uploaded file carries, and where it comes from.
export interface CarriedLabel {
  code: string;
  source: (typeof LABEL_SOURCES)[number];
}

// What the policy service reads in an uploaded file: the label it carries,
// null for none, and whether its binding signature matched the platform's
// certificate.
export interface UploadReading {
  label: CarriedLabel | null;
  signature: 'matched' | 'not-matched' | 'absent';
}

// An uploaded file once the policy service wrote the platform's parts into
// it, in the format its main part gives.
export interface PreparedUpload {
  file: Uint8Array;
  format: DocumentFormat;
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
  #journal: Journal;
  #log: FastifyBaseLogger;
  #latestSignatureOf: (documentId: string) => Promise<string | null>;

  constructor(
    policyInternalUrl: string,
    secret: string,
    journal: Journal,
    log: FastifyBaseLogger,
    latestSignatureOf: (documentId: string) => Promise<string | null>,
  ) {
    this.#policyUrl = policyInternalUrl;
    this.#secret = secret;
    this.#journal = journal;
    this.#log = log;
    this.#latestSignatureOf = latestSignatureOf;
  }

  // `stored` is the file as stored before this save: the editor never sees
  // the sensitivity label the policy service writes, so the label's date and
  // action id come from the stored file's custom properties.
  async signed(file: Uint8Array, document: DocumentRef, stored: Uint8Array | null): Promise<SignedFile> {
    const headers = await this.#storedPropertiesHeader(stored, document.id);
    return (await this.#signedOrNull(file, document, headers, 'The binding of a save could not be signed')) ?? { content: file, signatureValue: null };
  }

  // The label an uploaded file carries, where it comes from, and whether its
  // binding signature matched, or why the policy service refuses the file,
  // sent as the format its name gives.
  async readUpload(file: Uint8Array, format: DocumentFormat): Promise<{ ok: true; value: UploadReading } | UploadRefusal> {
    return this.#uploadStep('/uploads/read', file, format, async (response) => readUploadReading(await response.json()));
  }

  // An uploaded file with the platform's parts, which the policy service
  // writes as the panel does, and its format, which the policy service reads
  // from its main part, whatever the file's name said; or why it refuses the
  // file.
  async preparedUpload(file: Uint8Array, format: DocumentFormat, base: string): Promise<{ ok: true; value: PreparedUpload } | UploadRefusal> {
    return this.#uploadStep(`/uploads/prepare?base=${encodeURIComponent(base)}`, file, format, async (response) => {
      const read = formatOfContentType(response.headers.get('content-type'));
      return read === null ? null : { file: new Uint8Array(await response.arrayBuffer()), format: read };
    });
  }

  // A step of an upload: the policy service's answer, or its refusal, which
  // it explains; a failure is logged.
  async #uploadStep<T>(
    route: string,
    file: Uint8Array,
    format: DocumentFormat,
    answerOf: (response: Response) => Promise<T | null>,
  ): Promise<{ ok: true; value: T } | UploadRefusal> {
    try {
      const response = await this.#post(route, file, format);
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
  async signedUpload(prepared: PreparedUpload, documentId: string): Promise<SignedFile | null> {
    return this.#signedOrNull(prepared.file, { id: documentId, format: prepared.format }, {}, 'The binding of an upload could not be signed');
  }

  // The file with the parts the policy service wrote, its signed binding
  // among them, signed for the document; null when it signed none, the
  // failure then logged.
  async #signedOrNull(file: Uint8Array, document: DocumentRef, headers: Record<string, string>, failure: string): Promise<SignedFile | null> {
    let answer: SignatureAnswer;
    try {
      answer = await this.#ask('/bindings/sign', file, document.format, readSignatureAnswer, { ...headers, [DOCUMENT_ID_HEADER]: document.id });
    } catch (error: unknown) {
      this.#log.error({ documentId: document.id, err: error }, failure);
      return null;
    }
    if (answer.replacement !== null) {
      this.#log.warn({ documentId: document.id, ...answer.replacement }, 'Document label replaced at save');
    }
    if (answer.signed === null) {
      return null;
    }
    const zip = await JSZip.loadAsync(file);
    for (const written of [...answer.parts, answer.signed]) {
      zip.file(written.part, written.xml);
    }
    return { content: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), signatureValue: answer.signed.signatureValue };
  }

  // Checks a stored file being served, aside: it is served all the same. A
  // file that no longer matches its binding's signature, or whose signature
  // is not the latest the portal stored for the document, goes into the
  // journal, and so does one that holds none, until its next save signs it,
  // with who downloaded it, if anyone did.
  checkAside(file: Uint8Array, document: CheckedDocument, servedTo: ServedTo, downloader: UserIdentity | null): void {
    this.#check(file, document, servedTo, downloader).catch((error: unknown) => {
      this.#log.error({ documentId: document.id, servedTo, err: error }, 'The signature of a stored file could not be checked');
    });
  }

  async #check(file: Uint8Array, document: CheckedDocument, servedTo: ServedTo, downloader: UserIdentity | null): Promise<void> {
    const documentId = document.id;
    const served = { [DOCUMENT_ID_HEADER]: documentId, ...(document.latestSignature === null ? {} : { [LATEST_SIGNATURE_HEADER]: document.latestSignature }) };
    const verification = await this.#ask('/bindings/verify', file, document.format, readVerification, served);
    // A save that came between the lookup and the reading of the file moved
    // the latest signature on: the file served was the newer one.
    const superseded =
      verification.status === 'altered' && verification.reason === NOT_THE_LATEST && (await this.#latestSignatureOf(documentId)) !== document.latestSignature;
    const people = downloader === null ? [] : [journalPerson('downloader', downloader)];
    const alert = (level: 'info' | 'warn', message: string, fields: Record<string, unknown>): void => {
      this.#journal.record({ category: 'stored-file', level, message, documentId, fields: { servedTo, ...fields }, people });
    };
    if (verification.status === 'altered' && !superseded) {
      const { reason, changedParts } = verification;
      alert('warn', 'Stored file no longer matches its signature', { reason, changedParts });
    } else if (verification.status === 'unsigned') {
      alert('info', 'Stored file unsigned', {});
    }
    // The platform never writes one (ADR 0005): it came from outside, and Word
    // could show its label instead of the signed one.
    if (verification.labelInformationPart !== null) {
      alert('warn', 'Stored file holds a Sensitivity Label Information part', { part: verification.labelInformationPart });
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

  async #ask<T>(route: string, file: Uint8Array, format: DocumentFormat, read: (body: unknown) => T | null, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.#post(route, file, format, headers);
    const body: unknown = await response.json();
    const answer = response.ok ? read(body) : null;
    if (answer === null) {
      const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'an unexpected answer';
      throw new Error(`The policy service answered ${response.status}: ${reason}`);
    }
    return answer;
  }

  // Sends a package, with its format's media type, to a route of the policy
  // service that only the portal may call.
  async #post(route: string, file: Uint8Array, format: DocumentFormat, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(new URL(route, this.#policyUrl), {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${this.#secret}`, 'content-type': DOCUMENT_FORMATS[format].contentType },
      body: file,
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
  const written = writtenPartOf(signed);
  const signatureValue: unknown = typeof signed === 'object' && signed !== null && 'signatureValue' in signed ? signed.signatureValue : null;
  const signedPart = written === null || typeof signatureValue !== 'string' ? null : { ...written, signatureValue };
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
  const known = LABEL_SOURCES.find((candidate) => candidate === source);
  return typeof code === 'string' && known !== undefined ? { label: { code, source: known }, signature } : null;
}
