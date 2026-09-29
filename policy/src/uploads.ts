import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type Document, XMLSerializer } from '@xmldom/xmldom';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type JSZip from 'jszip';
import { escapeXml } from './adatp4774.ts';
import { BINDING_NAMESPACE, bindablePartsOf, serializeDocumentBinding } from './adatp4778.ts';
import {
  appendRelationship,
  CONTENT_TYPES_NAMESPACE,
  CONTENT_TYPES_PART,
  customXmlParts,
  declareContentType,
  loadPackage,
  PACKAGE_RELATIONSHIPS_PART,
  RELATIONSHIPS_NAMESPACE,
  xmlPartOf,
} from './opc.ts';
import { type DocumentLabelOf, packageBody, readPackageLabels } from './package-signing.ts';
import { parseXml } from './xml.ts';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAIN_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CUSTOM_XML_PROPERTIES_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';
const DATASTORE_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
const OFFICE_DOCUMENT_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const CUSTOM_XML_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CUSTOM_XML_PROPERTIES_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps';
// The plugin's part for the base label (plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
// An OLE compound file ([MS-CFB] §2.2), the container of an encrypted Office
// document ([MS-OFFCRYPTO] §1.3.3.4), and a ZIP package.
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// Why an uploaded file cannot become a document.
export type UploadRefusal =
  | 'not-a-package'
  | 'rights-management'
  | 'password'
  | 'compound-file'
  | 'not-a-document'
  | 'unknown-label'
  | 'several-bindings'
  | 'malformed-binding'
  | 'portion-labels';

const REFUSALS: Readonly<Record<UploadRefusal, string>> = {
  'not-a-package': 'The file is no DOCX package',
  'rights-management': 'Microsoft Purview encrypted the file: remove its protection first',
  password: 'A password protects the file: remove it first',
  'compound-file': 'The file is a legacy Office document, not a DOCX package',
  'not-a-document': 'The package holds no Word document',
  'unknown-label': 'The base label designates no label of the security policy',
  'several-bindings': 'The file holds several document label bindings, where ADatP-4778.2 allows one',
  'malformed-binding': "The file's document label binding is not well-formed XML",
  'portion-labels': "The labels of the file's protected portions give no document label under the security policy",
};

export interface UploadOptions {
  secret: string;
  documentLabelOf: DocumentLabelOf;
  // A label code in its canonical form, null when it designates no label.
  canonicalLabelCode: (code: string) => string | null;
}

// The portal passes each uploaded file to the policy service, which refuses
// what cannot become a document, then writes the platform's parts into it as
// the panel writes them: the base label part, and the binding of the document
// label computed from that base label and the portion labels in clear, which
// references the parts the package holds. The portal then has the binding
// signed, as at a save. The DOCX body parser comes from acceptPackages.
export function registerUploads(app: FastifyInstance, options: UploadOptions): void {
  // Unchecked input: a repeated parameter arrives as an array.
  app.post<{ Querystring: { base?: unknown } }>('/uploads/prepare', async (request, reply) => {
    const received = packageBody(request, options.secret);
    if (!received.ok) {
      return reply.code(received.status).send({ error: received.error });
    }
    const requested = request.query.base;
    if (typeof requested !== 'string' || requested === '') {
      return reply.code(400).send({ error: 'Expected one base label code' });
    }
    const opened = await openUpload(received.body);
    if (!opened.ok) {
      return refuse(reply, opened.refusal);
    }
    const { zip, mainPart } = opened;
    const base = options.canonicalLabelCode(requested);
    if (base === null) {
      return refuse(reply, 'unknown-label');
    }
    const labels = await readPackageLabels(zip);
    if (labels.unreadableBindings.length > 0) {
      return refuse(reply, 'malformed-binding');
    }
    if (labels.bindings.length > 1) {
      return refuse(reply, 'several-bindings');
    }
    const computed = options.documentLabelOf(base, labels.portionCodes);
    if (!computed.ok) {
      return refuse(reply, 'portion-labels');
    }
    const parts = Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false);
    await writeCustomXmlPart(zip, mainPart, DOCUMENT_NAMESPACE, `<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="${escapeXml(base)}" label="${escapeXml(computed.code)}"/>`);
    await writeCustomXmlPart(zip, mainPart, BINDING_NAMESPACE, serializeDocumentBinding(computed.labelXml, bindablePartsOf(parts)));
    return reply.type(DOCX_TYPE).send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });
}

function refuse(reply: FastifyReply, refusal: UploadRefusal): FastifyReply {
  return reply.code(422).send({ error: REFUSALS[refusal], reason: refusal });
}

// The package of an uploaded WordprocessingML document, with its main part,
// or why it is none. An encrypted file is a compound file whose directory
// names its data spaces and streams in UTF-16 ([MS-OFFCRYPTO] §2.2, §2.3).
async function openUpload(body: Buffer): Promise<{ ok: true; zip: JSZip; mainPart: string } | { ok: false; refusal: UploadRefusal }> {
  if (body.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)) {
    const names = (name: string): boolean => body.includes(Buffer.from(name, 'utf16le'));
    if (names('DRMEncryptedDataSpace')) {
      return { ok: false, refusal: 'rights-management' };
    }
    return { ok: false, refusal: names('EncryptionInfo') ? 'password' : 'compound-file' };
  }
  const zip = body.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE) ? await loadPackage(body) : null;
  if (zip === null) {
    return { ok: false, refusal: 'not-a-package' };
  }
  const mainPart = await mainDocumentPart(zip);
  return mainPart === null ? { ok: false, refusal: 'not-a-document' } : { ok: true, zip, mainPart };
}

// The WordprocessingML main document part: the target of the package's
// officeDocument relationship, of the main document's content type.
async function mainDocumentPart(zip: JSZip): Promise<string | null> {
  const relationships = await xmlPartOf(zip, PACKAGE_RELATIONSHIPS_PART);
  const target = Array.from(relationships?.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship') ?? [])
    .find((relationship) => relationship.getAttribute('Type') === OFFICE_DOCUMENT_RELATIONSHIP)
    ?.getAttribute('Target')
    ?.replace(/^\//, '');
  const types = await xmlPartOf(zip, CONTENT_TYPES_PART);
  const typed = Array.from(types?.getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, 'Override') ?? []).some(
    (override) => override.getAttribute('PartName') === `/${target}` && override.getAttribute('ContentType') === MAIN_DOCUMENT_TYPE,
  );
  return target !== undefined && typed && zip.file(target) !== null ? target : null;
}

// Writes the Custom XML part of a namespace: again when the package holds
// one, else as a new part of the main document, with its properties part and
// relationships, as ONLYOFFICE writes those of the panel.
async function writeCustomXmlPart(zip: JSZip, mainPart: string, namespace: string, xml: string): Promise<void> {
  for (const part of await customXmlParts(zip)) {
    const parsed = parseXml((await zip.file(part)?.async('string')) ?? '');
    if (parsed.ok && parsed.root.namespaceURI === namespace) {
      zip.file(part, xml);
      return;
    }
  }
  let number = 1;
  while (zip.file(`customXml/item${number}.xml`) !== null || zip.file(`customXml/itemProps${number}.xml`) !== null) {
    number += 1;
  }
  const item = `customXml/item${number}.xml`;
  const properties = `itemProps${number}.xml`;
  zip.file(item, xml);
  zip.file(
    `customXml/${properties}`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ds:datastoreItem ds:itemID="{${randomUUID().toUpperCase()}}" xmlns:ds="${DATASTORE_NAMESPACE}"><ds:schemaRefs><ds:schemaRef ds:uri="${namespace}"/></ds:schemaRefs></ds:datastoreItem>`,
  );
  zip.file(
    `customXml/_rels/item${number}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${CUSTOM_XML_PROPERTIES_RELATIONSHIP}" Target="${properties}"/></Relationships>`,
  );
  const mainRelationshipsPart = path.posix.join(path.posix.dirname(mainPart), '_rels', `${path.posix.basename(mainPart)}.rels`);
  const mainRelationships = (await xmlPartOf(zip, mainRelationshipsPart)) ?? emptyRelationships();
  appendRelationship(mainRelationships, CUSTOM_XML_RELATIONSHIP, path.posix.relative(path.posix.dirname(mainPart), item));
  zip.file(mainRelationshipsPart, new XMLSerializer().serializeToString(mainRelationships));
  const types = await xmlPartOf(zip, CONTENT_TYPES_PART);
  if (types === null) {
    throw new Error('The content types part cannot be read');
  }
  declareContentType(types, `/customXml/${properties}`, CUSTOM_XML_PROPERTIES_TYPE);
  zip.file(CONTENT_TYPES_PART, new XMLSerializer().serializeToString(types));
}

function emptyRelationships(): Document {
  const parsed = parseXml(`<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"/>`);
  const document = parsed.ok ? parsed.root.ownerDocument : null;
  if (document === null) {
    throw new Error('An empty relationships part cannot be parsed');
  }
  return document;
}
