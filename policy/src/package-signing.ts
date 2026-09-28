import type { Element } from '@xmldom/xmldom';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import JSZip from 'jszip';
import { LABEL_NAMESPACE } from './adatp4774.ts';
import { BINDING_NAMESPACE, packPartName } from './adatp4778.ts';
import { holdsSecret } from './bearer.ts';
import { type AlterationReason, bindingAltered, type BindingSigner, signedDocumentBinding, verifyDocumentBinding } from './binding-signature.ts';
import { parseXml } from './xml.ts';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// The plugin's parts and tags (plugin/src/portions.ts).
const DOCUMENT_NAMESPACE = 'urn:linagora:dcs:document:1';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PLACEHOLDER_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
// Saved documents, pictures included, stay well below this.
const PACKAGE_LIMIT_BYTES = 100 * 1024 * 1024;

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
  now: () => Date;
}

interface PackageBinding {
  part: string;
  root: Element;
}

interface PackageLabels {
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
  app.addContentTypeParser(DOCX_TYPE, { parseAs: 'buffer', bodyLimit: PACKAGE_LIMIT_BYTES }, (_request, body, done) => {
    done(null, body);
  });

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
      return { signed: null, replacement: null };
    }
    const computed = options.documentLabelOf(labels.baseCode, labels.portionCodes);
    if (!computed.ok) {
      return reply.code(422).send({ error: computed.error });
    }
    const current = binding.root.getElementsByTagNameNS(LABEL_NAMESPACE, 'originatorConfidentialityLabel')[0] ?? null;
    const before = current === null ? null : options.codeOfLabelXml(current.toString());
    const references = Array.from(binding.root.getElementsByTagNameNS(BINDING_NAMESPACE, 'DataReference'))
      .map((reference) => packPartName(reference.getAttribute('URI') ?? ''))
      .filter((name): name is string => name !== null);
    const parts = await partsOf(zip, references);
    const missing = references.filter((name) => !parts.has(name));
    if (missing.length > 0) {
      return reply.code(422).send({ error: `The binding references parts the package lacks: ${missing.join(', ')}` });
    }
    return {
      signed: { part: binding.part, xml: signedDocumentBinding(computed.labelXml, parts, options.signer, options.now()) },
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
    const sole = soleBinding(await readPackageLabels(zip));
    if (!sole.ok) {
      return bindingAltered(sole.reason);
    }
    if (sole.binding === null) {
      return { status: 'unlabelled' };
    }
    const bindingXml = (await zip.file(sole.binding.part)?.async('string')) ?? '';
    const names = Object.keys(zip.files).filter((name) => zip.files[name]?.dir === false);
    return verifyDocumentBinding(bindingXml, await partsOf(zip, names), options.signer.certificate);
  });
}

// The package a request from the portal carries, or why it is refused.
async function packageOf(request: FastifyRequest, secret: string): Promise<{ ok: true; zip: JSZip } | { ok: false; status: 403 | 415 | 422; error: string }> {
  if (!holdsSecret(request, secret)) {
    return { ok: false, status: 403, error: 'Only the portal may have bindings signed or verified' };
  }
  if (!Buffer.isBuffer(request.body)) {
    return { ok: false, status: 415, error: `Expected a ${DOCX_TYPE} body` };
  }
  const zip = await loadPackage(request.body);
  return zip === null ? { ok: false, status: 422, error: 'The body is no DOCX package' } : { ok: true, zip };
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

async function loadPackage(body: Buffer): Promise<JSZip | null> {
  try {
    return await JSZip.loadAsync(body);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

// The bindings, the base label and the portion labels in clear of a package:
// the placeholders' tags hold the portion labels the panel computes the
// document label from.
async function readPackageLabels(zip: JSZip): Promise<PackageLabels> {
  const bindings: PackageBinding[] = [];
  const unreadableBindings: string[] = [];
  let baseCode: string | null = null;
  for (const part of Object.keys(zip.files).filter((file) => /^customXml\/item\d+\.xml$/.test(file)).sort()) {
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
  }
  const portionCodes: string[] = [];
  for (const part of Object.keys(zip.files).filter((file) => PLACEHOLDER_PART.test(file))) {
    const root = await rootOf(zip, part);
    for (const tag of Array.from(root?.getElementsByTagNameNS(WORD_NAMESPACE, 'tag') ?? [])) {
      const label = portionLabelOf(tag.getAttributeNS(WORD_NAMESPACE, 'val'));
      if (label !== null) {
        portionCodes.push(label);
      }
    }
  }
  return { bindings, unreadableBindings, baseCode, portionCodes };
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
