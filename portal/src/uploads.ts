import multipart from '@fastify/multipart';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { requireSession } from './auth/routes.ts';
import type { UserIdentity } from './auth/sessions.ts';
import type { BindingSignatures } from './binding-signature.ts';
import { markingOfLabel } from './document-access.ts';
import { newDocumentId, storeNewDocument } from './documents.ts';
import type { LabelJournal } from './label-journal.ts';
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

// A person brings a DOCX into the portal and chooses its base label (an
// upload). The policy service refuses what cannot become a document, writes
// the platform's parts into it and signs its binding, as at a save; the
// portal stores the result as a new document, named after the uploaded file,
// and logs it. Only this route reads multipart bodies.
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
      if (upload === null || upload.content.length === 0 || base === '') {
        return refuse(reply, 400, 'Choose a DOCX file and its base label.');
      }
      // The labels the form offers, and no other.
      const offered = await labelsForUpload(options.policyInternalUrl, user, request.log);
      if (offered === null) {
        return refuse(reply, 503, 'The policy service cannot tell which labels your clearance allows. Try again later.');
      }
      if (!offered.some((label) => label.code === base)) {
        return refuse(reply, 403, 'The base label is not among those your clearance allows.');
      }
      const prepared = await options.signatures.preparedUpload(upload.content, base);
      if (!prepared.ok) {
        return refuse(reply, prepared.status, prepared.message);
      }
      const documentId = newDocumentId(upload.fileName);
      const signed = await options.signatures.signedUpload(prepared.docx, documentId);
      if (signed === null) {
        return refuse(reply, 503, 'The policy service could not sign the document. Try again later.');
      }
      await storeNewDocument(options.documentsDirectory, documentId, signed, upload.fileName);
      options.journal.recordUpload({ documentId, base }, user.id);
      return reply.redirect(`/documents/${documentId}/edit`, 303);
    });
  });
}

// The labels a person's clearance allows under the first policy, as the panel
// offers them for a new portion; null when the policy service cannot tell.
export async function labelsForUpload(policyInternalUrl: string, user: UserIdentity, log: FastifyBaseLogger): Promise<UploadLabel[] | null> {
  try {
    const policies = await policyJson(new URL('/policies', policyInternalUrl), {});
    const first: unknown = Array.isArray(policies) ? policies[0] : null;
    const name: unknown = typeof first === 'object' && first !== null && 'name' in first ? first.name : null;
    if (typeof name !== 'string') {
      throw new Error('The policy service declares no policy');
    }
    const labels = await policyJson(new URL(`/policies/${encodeURIComponent(name)}/labels/allowed`, policyInternalUrl), identityHeaders(user));
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
