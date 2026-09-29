import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type Document, XMLSerializer } from '@xmldom/xmldom';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type JSZip from 'jszip';
import { escapeXml } from './adatp4774.ts';
import { BINDING_NAMESPACE, bindablePartsOf, serializeDocumentBinding } from './adatp4778.ts';
import { type LabelMapping, labelOfSensitivityLabel } from './label-mapping.ts';
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
import { bindingLabelXml, bindingVerdict, type DocumentLabelOf, type PackageLabels, packageBody, readPackageLabels } from './package-signing.ts';
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
  | 'portion-labels'
  | 'foreign-label'
  | 'invalid-label';

// The label code that a code or a label element gives, or why it gives none:
// a label of another security policy, or no valid label of the platform's.
export type ReadLabel = { ok: true; code: string } | { ok: false; refusal: 'foreign-label' | 'invalid-label' };

// Where the label an uploaded file carries comes from: the platform's base
// label part, the document label of an ADatP-4778 binding, or a sensitivity
// label that the label mapping knows.
export type LabelSource = 'base-label' | 'binding' | 'sensitivity-label';

// The label an uploaded file carries, and where it comes from, or why the
// platform cannot take it.
type CarriedLabel = { ok: true; code: string; source: LabelSource } | Extract<ReadLabel, { ok: false }>;

// What the binding signature of an uploaded file says against the platform's
// certificate.
export type SignatureStatus = 'matched' | 'not-matched' | 'absent';

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
  'foreign-label': "The file's label belongs to another security policy",
  'invalid-label': "The file's label is no valid label of the security policy",
};

export interface UploadOptions {
  secret: string;
  // The certificate a binding signature must match.
  certificate: string;
  documentLabelOf: DocumentLabelOf;
  // A label code in its canonical form, or why it designates no label.
  readLabelCode: (code: string) => ReadLabel;
  // The code of the label an ADatP-4774 label element designates, or why it
  // designates none.
  readLabelXml: (xml: string) => ReadLabel;
  // A valid label code without the informative categories that only a
  // document label takes.
  baseLabelOf: (code: string) => string;
  // Null without a label mapping, which leaves sensitivity labels unread.
  labelMapping: LabelMapping | null;
}

// The portal passes each uploaded file to the policy service twice. First it
// reads the label the file carries, with where it comes from and whether its
// binding signature matched, so that the portal decides the base label.
// Then the policy service writes the platform's parts into it as the panel
// writes them: the base label part, and the binding of the document label
// computed from that base label and the portion labels in clear, which
// references the parts the package holds. The portal then has the binding
// signed, as at a save. Both refuse what cannot become a document. The DOCX
// body parser comes from acceptPackages.
export function registerUploads(app: FastifyInstance, options: UploadOptions): void {
  app.post('/uploads/read', async (request, reply) => {
    const received = packageBody(request, options.secret);
    if (!received.ok) {
      return reply.code(received.status).send({ error: received.error });
    }
    const uploaded = await uploadedPackage(received.body);
    if (!uploaded.ok) {
      return refuse(reply, uploaded.refusal);
    }
    const carried = await carriedLabel(uploaded.zip, uploaded.labels, options);
    if (carried !== null && !carried.ok) {
      return refuse(reply, carried.refusal);
    }
    return {
      label: carried === null ? null : { code: carried.code, source: carried.source },
      signature: await signatureStatus(uploaded.zip, uploaded.labels, options),
    };
  });

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
    const uploaded = await uploadedPackage(received.body);
    if (!uploaded.ok) {
      return refuse(reply, uploaded.refusal);
    }
    const { zip, mainPart, labels } = uploaded;
    const base = options.readLabelCode(requested);
    if (!base.ok) {
      return refuse(reply, 'unknown-label');
    }
    const computed = options.documentLabelOf(base.code, labels.portionCodes);
    if (!computed.ok) {
      return refuse(reply, 'portion-labels');
    }
    const parts = Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false);
    await writeCustomXmlPart(zip, mainPart, DOCUMENT_NAMESPACE, `<dcs:document xmlns:dcs="${DOCUMENT_NAMESPACE}" base="${escapeXml(base.code)}" label="${escapeXml(computed.code)}"/>`);
    await writeCustomXmlPart(zip, mainPart, BINDING_NAMESPACE, serializeDocumentBinding(computed.labelXml, bindablePartsOf(parts)));
    return reply.type(DOCX_TYPE).send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });
}

// An uploaded package, with its main part and its labels in clear, or why it
// cannot become a document: its binding, if it has one, must be one that
// signing can replace.
async function uploadedPackage(body: Buffer): Promise<{ ok: true; zip: JSZip; mainPart: string; labels: PackageLabels } | { ok: false; refusal: UploadRefusal }> {
  const opened = await openUpload(body);
  if (!opened.ok) {
    return opened;
  }
  const labels = await readPackageLabels(opened.zip);
  if (labels.unreadableBindings.length > 0) {
    return { ok: false, refusal: 'malformed-binding' };
  }
  if (labels.bindings.length > 1) {
    return { ok: false, refusal: 'several-bindings' };
  }
  return { ...opened, labels };
}

// The label an uploaded file carries: the platform's base label part, else
// the document label of its binding, found in whichever Custom XML part holds
// it, as a base label, else the label that the label mapping pairs with its
// sensitivity label; null when it carries none.
async function carriedLabel(zip: JSZip, labels: PackageLabels, options: UploadOptions): Promise<CarriedLabel | null> {
  if (labels.baseCode !== null) {
    const read = options.readLabelCode(labels.baseCode);
    return read.ok ? { ...read, source: 'base-label' } : read;
  }
  const [binding] = labels.bindings;
  const xml = binding === undefined ? null : bindingLabelXml(binding);
  if (xml !== null) {
    const read = options.readLabelXml(xml);
    return read.ok ? { ok: true, code: options.baseLabelOf(read.code), source: 'binding' } : read;
  }
  const mapped = options.labelMapping === null ? null : await labelOfSensitivityLabel(options.labelMapping, zip);
  return mapped === null ? null : { ok: true, code: mapped, source: 'sensitivity-label' };
}

// Whether an uploaded file's binding signature matched the platform's
// certificate. The signature does not cover the base label part: a signed
// document label that the labels in clear no longer give was changed since
// signing, and does not match either.
async function signatureStatus(zip: JSZip, labels: PackageLabels, options: UploadOptions): Promise<SignatureStatus> {
  if (labels.bindings.length === 0) {
    return 'absent';
  }
  const verdict = await bindingVerdict(zip, labels, options.certificate);
  if (verdict.status !== 'valid') {
    return verdict.status === 'altered' ? 'not-matched' : 'absent';
  }
  const [binding] = labels.bindings;
  const xml = binding === undefined ? null : bindingLabelXml(binding);
  const signed = xml === null ? null : options.readLabelXml(xml);
  const computed = options.documentLabelOf(labels.baseCode, labels.portionCodes);
  return signed?.ok === true && computed.ok && signed.code === computed.code ? 'matched' : 'not-matched';
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
