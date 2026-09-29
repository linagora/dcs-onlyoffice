import type { Element } from '@xmldom/xmldom';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type JSZip from 'jszip';
import { LABEL_NAMESPACE } from './adatp4774.ts';
import { BINDING_NAMESPACE, bindablePartsOf } from './adatp4778.ts';
import { holdsSecret } from './bearer.ts';
import { type AlterationReason, bindingAltered, type BindingSigner, type BindingVerification, signedDocumentBinding, verifyDocumentBinding } from './binding-signature.ts';
import { customXmlParts, holdsWorkbook, loadPackage, partNamesOf } from './opc.ts';
import { labelInformationPartOf, type MappedSensitivityLabel, writeSensitivityLabel } from './sensitivity-label.ts';
import { parseXml } from './xml.ts';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// The plugin's parts and tags (plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const PORTION_NAMESPACE = 'urn:linagora:dcs:portion:1';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PLACEHOLDER_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;
// The extension in which ONLYOFFICE writes a sheet's user protected ranges.
const USER_PROTECTED_RANGES_EXTENSION = '{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}';
// Saved documents, pictures included, stay well below this.
const PACKAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const STORED_CUSTOM_PROPERTIES_HEADER = 'x-stored-custom-properties';

// The document label that a base label and portion labels give, as the panel
// computes it: its code and its ADatP-4774 label element.
export type DocumentLabelOf = (baseCode: string | null, portionCodes: string[]) => { ok: true; code: string; labelXml: string } | { ok: false; error: string };

export interface PackageSignatureOptions {
  secret: string;
  signer: BindingSigner;
  documentLabelOf: DocumentLabelOf;
  // The code of the label an ADatP-4774 label element designates, null when
  // it designates no valid label.
  codeOfLabelXml: (xml: string) => string | null;
  // What the label mapping gives a document label, or a document without
  // one; null without a mapping.
  sensitivityLabelOf: (documentLabelCode: string | null) => MappedSensitivityLabel | null;
  now: () => Date;
}

export interface PackageBinding {
  part: string;
  root: Element;
}

export interface PackageLabels {
  bindings: PackageBinding[];
  // Parts in the binding's namespace that are no well-formed XML without a
  // DTD.
  unreadableBindings: string[];
  baseCode: string | null;
  portionCodes: string[];
}

// The portal has the policy service sign the binding of each save it stores
// (ADR 0004), and verify it whenever it serves a stored file: only the portal
// holds the secret. To sign, the policy service computes the document label
// again from the base label and the portion labels in clear, as the panel
// does, and writes the binding again with that label and the package parts it
// referenced, so that nothing written in it by hand gets signed. It reports a
// label that differed, then signs.
export function registerPackageSignatures(app: FastifyInstance, options: PackageSignatureOptions): void {
  app.post('/bindings/sign', async (request, reply) => {
    const received = await packageOf(request, options.secret);
    if (!received.ok) {
      return reply.code(received.status).send({ error: received.error });
    }
    const { zip } = received;
    const labels = await readPackageLabels(zip);
    const sole = soleBinding(labels);
    if (!sole.ok) {
      return reply.code(422).send({ error: sole.reason });
    }
    const { binding } = sole;
    if (binding === null) {
      // No document label, no sensitivity label: one the file carries goes.
      const unlabelled = options.sensitivityLabelOf(null);
      const { writtenParts } = unlabelled === null ? { writtenParts: [] } : await writeSensitivityLabel(zip, unlabelled, options.now(), storedCustomProperties(request));
      return { signed: null, parts: await partsWritten(zip, writtenParts), replacement: null };
    }
    const computed = options.documentLabelOf(labels.baseCode, labels.portionCodes);
    if (!computed.ok) {
      return reply.code(422).send({ error: computed.error });
    }
    const current = bindingLabelXml(binding);
    const before = current === null ? null : options.codeOfLabelXml(current);
    // The sensitivity label goes in parts the signature covers, so it is
    // written first (ADR 0005).
    const mapped = options.sensitivityLabelOf(computed.code);
    const { writtenParts } = mapped === null ? { writtenParts: [] } : await writeSensitivityLabel(zip, mapped, options.now(), storedCustomProperties(request));
    // The binding references every part of ADatP-4778.2 Tables 5-2 and 5-3
    // that the package holds, the custom properties part written just now
    // included: only the saved package tells which parts exist.
    const parts = await partsOf(zip, bindablePartsOf(partNamesOf(zip)));
    return {
      signed: { part: binding.part, xml: signedDocumentBinding(computed.labelXml, parts, options.signer, options.now()) },
      // The other parts written, which the portal stores with the binding.
      parts: await partsWritten(zip, writtenParts),
      replacement: before === computed.code ? null : { before, after: computed.code },
    };
  });

  // Whether a stored package still matches its binding's signature, which the
  // portal asks whenever it serves a stored file. A package without labels,
  // which no save signs, is unlabelled.
  app.post('/bindings/verify', async (request, reply) => {
    const received = await packageOf(request, options.secret);
    if (!received.ok) {
      return reply.code(received.status).send({ error: received.error });
    }
    const { zip } = received;
    // A Sensitivity Label Information part could change the label Word shows,
    // and the signature does not cover it: the verdict names it.
    const labelInformationPart = await labelInformationPartOf(zip);
    return { ...(await bindingVerdict(zip, await readPackageLabels(zip), options.signer.certificate)), labelInformationPart };
  });
}

// The parts written, as the portal stores them.
async function partsWritten(zip: JSZip, names: string[]): Promise<{ part: string; xml: string }[]> {
  return Promise.all(names.map(async (part) => ({ part, xml: (await zip.file(part)?.async('string')) ?? '' })));
}

// The custom properties part of the file as stored before this save, which the
// portal sends base64-encoded in a header, empty when the stored file has
// none; null when it sends no header.
function storedCustomProperties(request: FastifyRequest): string | null {
  const header = request.headers[STORED_CUSTOM_PROPERTIES_HEADER];
  return typeof header === 'string' ? Buffer.from(header, 'base64').toString('utf8') : null;
}

// The package a request from the portal carries, or why it is refused.
async function packageOf(request: FastifyRequest, secret: string): Promise<{ ok: true; zip: JSZip } | { ok: false; status: 403 | 415 | 422; error: string }> {
  const received = packageBody(request, secret);
  if (!received.ok) {
    return received;
  }
  const zip = await loadPackage(received.body);
  return zip === null ? { ok: false, status: 422, error: 'The body is no DOCX or XLSX package' } : { ok: true, zip };
}

// The routes that take a package read it as a DOCX or an XLSX body, up to a
// size no saved document reaches.
export function acceptPackages(app: FastifyInstance): void {
  app.addContentTypeParser([DOCX_TYPE, XLSX_TYPE], { parseAs: 'buffer', bodyLimit: PACKAGE_LIMIT_BYTES }, (_request, body, done) => {
    done(null, body);
  });
}

// The body of a request that only the portal may send, which holds a package.
export function packageBody(request: FastifyRequest, secret: string): { ok: true; body: Buffer } | { ok: false; status: 403 | 415; error: string } {
  if (!holdsSecret(request, secret)) {
    return { ok: false, status: 403, error: 'Only the portal may send packages to the policy service' };
  }
  if (!Buffer.isBuffer(request.body)) {
    return { ok: false, status: 415, error: `Expected a ${DOCX_TYPE} or ${XLSX_TYPE} body` };
  }
  return { ok: true, body: request.body };
}

// The document label a binding holds, as the ADatP-4774 originator label
// element it wrote; null when it holds none.
export function bindingLabelXml(binding: PackageBinding): string | null {
  return binding.root.getElementsByTagNameNS(LABEL_NAMESPACE, 'originatorConfidentialityLabel')[0]?.toString() ?? null;
}

// What a package's binding signature says against the certificate: valid,
// altered, unsigned, or no labels at all.
export async function bindingVerdict(zip: JSZip, labels: PackageLabels, certificate: string): Promise<BindingVerification | { status: 'unlabelled' }> {
  const sole = soleBinding(labels);
  if (!sole.ok) {
    return bindingAltered(sole.reason);
  }
  if (sole.binding === null) {
    return { status: 'unlabelled' };
  }
  const bindingXml = (await zip.file(sole.binding.part)?.async('string')) ?? '';
  const names = partNamesOf(zip);
  return verifyDocumentBinding(bindingXml, await partsOf(zip, names), certificate);
}

// The package's one binding, null when it holds neither a binding nor a base
// label; otherwise why its binding cannot be signed or trusted.
function soleBinding(labels: PackageLabels): { ok: true; binding: PackageBinding | null } | { ok: false; reason: AlterationReason } {
  const [binding, ...others] = labels.bindings;
  if (labels.unreadableBindings.length > 0) {
    return { ok: false, reason: 'The binding is not well-formed XML' };
  }
  if (others.length > 0) {
    return { ok: false, reason: 'The package holds several document label bindings, where ADatP-4778.2 allows one' };
  }
  if (binding === undefined && labels.baseCode !== null) {
    return { ok: false, reason: 'The package has a base label but no document label binding' };
  }
  return { ok: true, binding: binding ?? null };
}

// The bindings, the base label and the portion labels in clear of a package,
// from which the panel computes the document label: in a text document, the
// placeholders' tags hold the portion labels; in a workbook, the portions'
// parts do.
export async function readPackageLabels(zip: JSZip): Promise<PackageLabels> {
  const bindings: PackageBinding[] = [];
  const unreadableBindings: string[] = [];
  let baseCode: string | null = null;
  const partLabels = new Map<string, string>();
  for (const part of await customXmlParts(zip)) {
    const xml = (await zip.file(part)?.async('string')) ?? '';
    const parsed = parseXml(xml);
    const root = parsed.ok ? parsed.root : null;
    if (root?.namespaceURI === BINDING_NAMESPACE && root.localName === 'BindingInformation') {
      bindings.push({ part, root });
    }
    if (root === null && xml.includes(BINDING_NAMESPACE)) {
      unreadableBindings.push(part);
    }
    if (root?.namespaceURI === DOCUMENT_NAMESPACE && root.localName === 'document') {
      baseCode = root.getAttribute('base') || null;
    }
    const id = root?.getAttribute('id') || null;
    const label = root?.getAttribute('label') || null;
    if (root?.namespaceURI === PORTION_NAMESPACE && root.localName === 'portion' && id !== null && label !== null) {
      partLabels.set(id, label);
    }
  }
  const portionCodes = holdsWorkbook(partNamesOf(zip)) ? await workbookPortionCodes(zip, partLabels) : await textDocumentPortionCodes(zip);
  return { bindings, unreadableBindings, baseCode, portionCodes };
}

// The portion labels a text document's placeholders, its content controls,
// hold in their tags.
async function textDocumentPortionCodes(zip: JSZip): Promise<string[]> {
  const portionCodes: string[] = [];
  for (const part of partNamesOf(zip).filter((file) => PLACEHOLDER_PART.test(file))) {
    const root = await rootOf(zip, part);
    for (const tag of Array.from(root?.getElementsByTagNameNS(WORD_NAMESPACE, 'tag') ?? [])) {
      const label = portionLabelOf(tag.getAttributeNS(WORD_NAMESPACE, 'val'));
      if (label !== null) {
        portionCodes.push(label);
      }
    }
  }
  return portionCodes;
}

// The labels of a workbook's portions, by the portion id: a portion counts
// when its part and its placeholder's user protected range, titled with its
// id, are both present (ADR 0006).
async function workbookPortionCodes(zip: JSZip, partLabels: ReadonlyMap<string, string>): Promise<string[]> {
  const anchored = new Set<string>();
  for (const part of partNamesOf(zip).filter((file) => WORKSHEET_PART.test(file))) {
    const root = await rootOf(zip, part);
    const extensions = Array.from(root?.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, 'ext') ?? []).filter(
      (extension) => extension.getAttribute('uri') === USER_PROTECTED_RANGES_EXTENSION,
    );
    for (const range of extensions.flatMap((extension) => Array.from(extension.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, 'userProtectedRange')))) {
      anchored.add(range.getAttribute('name') ?? '');
    }
  }
  return [...partLabels].filter(([id]) => anchored.has(id)).map(([, label]) => label);
}

// A part's root element, null when the part is missing or not well-formed
// XML without a DTD.
async function rootOf(zip: JSZip, part: string): Promise<Element | null> {
  const xml = await zip.file(part)?.async('string');
  const parsed = xml === undefined ? null : parseXml(xml);
  return parsed?.ok === true ? parsed.root : null;
}

// A placeholder's tag names its portion and its label.
function portionLabelOf(tag: string | null): string | null {
  try {
    const parsed: unknown = JSON.parse(tag ?? 'null');
    return typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' && 'label' in parsed && typeof parsed.label === 'string'
      ? parsed.label
      : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function partsOf(zip: JSZip, names: readonly string[]): Promise<Map<string, Uint8Array>> {
  const parts = new Map<string, Uint8Array>();
  for (const name of names) {
    const bytes = await zip.file(name)?.async('uint8array');
    if (bytes !== undefined) {
      parts.set(name, bytes);
    }
  }
  return parts;
}
