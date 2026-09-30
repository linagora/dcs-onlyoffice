import multipart from '@fastify/multipart';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { requireSession } from './auth/routes.ts';
import type { UserIdentity } from './auth/sessions.ts';
import type { BindingSignatures } from './binding-signature.ts';
import { markingOfLabel } from './document-access.ts';
import { FORMAT_NAMES, nameInFormat, newDocumentId, splitFileName, storeNewDocument } from './documents.ts';
import { isLowering, type LabelJournal } from './label-journal.ts';
import { renderMessagePage, type UploadLabel } from './pages.ts';
import { identityHeaders } from './policy-relay.ts';

// The largest file an upload takes.
export const UPLOAD_LIMIT_MEGABYTES = 20;
const POLICY_TIMEOUT_MS = 30_000;

export interface UploadOptions {
  policyInternalUrl: string;
  documentsDirectory: string;
  signatures: BindingSignatures;
  journal: LabelJournal;
}

// A person brings a DOCX or an XLSX into the portal (an upload). Its base
// label is the label the file carries, unless the person chooses another
// under the base label rule; one they must choose when it carries none. The
// policy service reads that label, refuses what cannot become a document,
// writes the platform's parts into it and signs its binding, as at a save;
// the portal stores the result as a new document of the format its main part
// gives, named after the uploaded file, and logs it. Only this route reads
// multipart bodies.
export function registerUploads(app: FastifyInstance, options: UploadOptions): void {
  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: UPLOAD_LIMIT_MEGABYTES * 1024 * 1024, files: 1 } });

    scope.post('/documents/upload', async (request, reply) => {
      const { user } = requireSession(request);
      let base = '';
      let upload: { fileName: string; content: Buffer } | null = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'field' && part.fieldname === 'base' && typeof part.value === 'string') {
            base = part.value;
          } else if (part.type === 'file' && part.fieldname === 'file') {
            upload = { fileName: part.filename, content: await part.toBuffer() };
          } else if (part.type === 'file') {
            part.file.resume();
          }
        }
      } catch (error: unknown) {
        if (error instanceof scope.multipartErrors.RequestFileTooLargeError) {
          return refuse(reply, 413, `The file is larger than ${UPLOAD_LIMIT_MEGABYTES} MB.`);
        }
        throw error;
      }
      if (upload === null || upload.content.length === 0) {
        return refuse(reply, 400, `Choose a ${FORMAT_NAMES} file.`);
      }
      // The name only says how to send the file: its main part decides.
      const namedFormat = splitFileName(upload.fileName).format ?? 'docx';
      const reading = await options.signatures.readUpload(upload.content, namedFormat);
      if (!reading.ok) {
        return refuse(reply, reading.status, reading.message);
      }
      const carried = reading.value.label;
      // The form's first option, empty, keeps the label the file carries.
      const kept = base === '' ? (carried?.code ?? null) : base;
      if (kept === null) {
        return refuse(reply, 400, 'The file carries no label: choose its base label.');
      }
      const offered = await labelsForUpload(options.policyInternalUrl, user, request.log, carried?.code ?? null);
      if (offered === null) {
        return refuse(reply, 503, 'The policy service cannot tell which labels your clearance allows. Try again later.');
      }
      const lowering = carried === null ? false : await isLowering(options.policyInternalUrl, carried.code, kept, request.log);
      if (!offered.some((label) => label.code === kept)) {
        if (kept === carried?.code) {
          return refuse(reply, 403, "The file's label is beyond your clearance.");
        }
        return refuse(
          reply,
          403,
          lowering === true ? "Only an administrator whose clearance allows the file's label may lower it." : 'The base label is not among those your clearance allows.',
        );
      }
      const prepared = await options.signatures.preparedUpload(upload.content, namedFormat, kept);
      if (!prepared.ok) {
        return refuse(reply, prepared.status, prepared.message);
      }
      // The document is named after the file, with its format's extension.
      const name = nameInFormat(upload.fileName, prepared.value.format);
      const documentId = newDocumentId(name);
      const signed = await options.signatures.signedUpload(prepared.value, documentId);
      if (signed === null) {
        return refuse(reply, 503, 'The policy service could not sign the document. Try again later.');
      }
      await storeNewDocument(options.documentsDirectory, documentId, signed.content, prepared.value.format, name, signed.signatureValue);
      options.journal.recordUpload({ documentId, base: kept, read: carried, signature: reading.value.signature }, lowering, user.id);
      return reply.redirect(`/documents/${documentId}/edit`, 303);
    });
  });
}

// The labels a person may give an uploaded file under the first policy, as
// the panel offers them for a portion: those their clearance allows, and,
// instead of a label the file carries, none lower unless they are an
// administrator whose clearance allows it. Null when the policy service
// cannot tell.
export async function labelsForUpload(policyInternalUrl: string, user: UserIdentity, log: FastifyBaseLogger, carried: string | null = null): Promise<UploadLabel[] | null> {
  try {
    const policies = await policyJson(new URL('/policies', policyInternalUrl), {});
    const first: unknown = Array.isArray(policies) ? policies[0] : null;
    const name: unknown = typeof first === 'object' && first !== null && 'name' in first ? first.name : null;
    if (typeof name !== 'string') {
      throw new Error('The policy service declares no policy');
    }
    const choices = carried === null ? 'labels/allowed' : `labels/portion-choices?current=${encodeURIComponent(carried)}`;
    const labels = await policyJson(new URL(`/policies/${encodeURIComponent(name)}/${choices}`, policyInternalUrl), identityHeaders(user));
    if (!Array.isArray(labels)) {
      throw new Error('Unexpected label list');
    }
    return labels.flatMap((label: unknown) => {
      const code: unknown = typeof label === 'object' && label !== null && 'code' in label ? label.code : null;
      const marking = markingOfLabel(label);
      return typeof code === 'string' && marking !== null ? [{ code, marking }] : [];
    });
  } catch (error: unknown) {
    log.error({ err: error }, 'The labels allowed for an upload could not be read');
    return null;
  }
}

async function policyJson(url: URL, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(POLICY_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`The policy service answered ${response.status} for ${url.pathname}`);
  }
  return response.json();
}

function refuse(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(renderMessagePage('Upload refused', message));
}
