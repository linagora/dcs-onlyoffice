import { type BinaryLike, createHash, createPrivateKey, createPublicKey, type KeyLike, KeyObject, sign, verify } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import { type HashAlgorithm, type SignatureAlgorithm, SignedXml } from 'xml-crypto';
import { escapeXml } from './adatp4774.ts';
import { BINDING_NAMESPACE, DOCUMENT_BINDING_ID, packPartName, packUri, serializeDocumentBinding } from './adatp4778.ts';
import { childElements, childrenNamed, parseXml } from './xml.ts';

const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';
const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
// ADatP-4778.2 makes SHA-384 digests (Table 2-3) and ECDSA with SHA-256
// signatures (Table 2-4) mandatory.
const SHA384 = 'http://www.w3.org/2001/04/xmldsig-more#sha384';
const ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
const WSU_NAMESPACE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const SIGNATURE_ID = 'binding-signature';
const MANIFEST_ID = 'binding-parts';
const PROPERTIES_ID = 'binding-signing-time';

// Why a document label binding, or its package, no longer matches what the
// policy service signed.
export type AlterationReason =
  | 'The binding is not well-formed XML'
  | 'The binding holds what its signature does not cover'
  | 'The signature does not hold'
  | 'Parts changed since signing'
  | 'The package has a base label but no document label binding'
  | 'The package holds several document label bindings, where ADatP-4778.2 allows one';

// What verifying a document label binding finds: a signature that holds,
// over parts unchanged since; one that no longer does, and why; or none.
export type BindingVerification =
  | { status: 'valid' }
  | { status: 'altered'; reason: AlterationReason; changedParts: string[] }
  | { status: 'unsigned' };

// The key and certificate the policy service signs bindings with, as PEM.
export interface BindingSigner {
  privateKey: string;
  certificate: string;
}

class Sha384 implements HashAlgorithm {
  getHash(xml: string): string {
    return sha384(xml);
  }

  getAlgorithmName(): string {
    return SHA384;
  }
}

// XML Signature 1.1 section 6.4.3: an ECDSA signature value is r and s
// concatenated, not the DER structure OpenSSL gives by default.
class EcdsaSha256 implements SignatureAlgorithm {
  getSignature(signedInfo: BinaryLike, privateKey: KeyLike): string {
    const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    return sign('sha256', Buffer.from(signedInfoBytes(signedInfo)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  }

  verifySignature(material: string, key: KeyLike, signatureValue: string): boolean {
    const publicKey = key instanceof KeyObject ? key : createPublicKey(key);
    return verify('sha256', Buffer.from(material), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureValue, 'base64'));
  }

  getAlgorithmName(): string {
    return ECDSA_SHA256;
  }
}

// The SHA-384 digest, in base64, of an XML text or of a package part.
function sha384(data: string | Uint8Array): string {
  return createHash('sha384').update(data).digest('base64');
}

function signedInfoBytes(signedInfo: BinaryLike): Uint8Array {
  if (typeof signedInfo === 'string') {
    return Buffer.from(signedInfo);
  }
  return signedInfo instanceof Uint8Array ? signedInfo : new Uint8Array(signedInfo.buffer, signedInfo.byteOffset, signedInfo.byteLength);
}

// The document label binding of a package, signed as ADatP-4778.2 Annexes A
// and B lay out. Its DataReferences name the given package parts, which go
// into a Manifest with their SHA-384 digests: signature libraries do not read
// pack:/// addresses, so a verifier digests those parts again itself. The
// signature also covers the MetadataBinding, whose label it vouches for, and
// the signing time. It goes first in the BindingInformation element.
export function signedDocumentBinding(labelXml: string, parts: ReadonlyMap<string, Uint8Array>, signer: BindingSigner, now: Date): string {
  const references = Array.from(
    parts,
    ([name, bytes]) => `<Reference URI="${escapeXml(packUri(name))}"><DigestMethod Algorithm="${SHA384}"/><DigestValue>${sha384(bytes)}</DigestValue></Reference>`,
  );
  const signature = new SignedXml({
    privateKey: signer.privateKey,
    publicCert: signer.certificate,
    signatureAlgorithm: ECDSA_SHA256,
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
    objects: [
      {
        content:
          `<Manifest Id="${MANIFEST_ID}">${references.join('')}</Manifest>` +
          `<SignatureProperties Id="${PROPERTIES_ID}"><SignatureProperty Target="#${SIGNATURE_ID}">` +
          `<wsu:Timestamp xmlns:wsu="${WSU_NAMESPACE}"><wsu:Created>${now.toISOString()}</wsu:Created></wsu:Timestamp>` +
          '</SignatureProperty></SignatureProperties>',
      },
    ],
  });
  signature.HashAlgorithms[SHA384] = Sha384;
  signature.SignatureAlgorithms[ECDSA_SHA256] = EcdsaSha256;
  signature.addReference({
    xpath: `//*[local-name(.)='MetadataBinding' and namespace-uri(.)='${BINDING_NAMESPACE}']`,
    transforms: [EXCLUSIVE_C14N],
    digestAlgorithm: SHA384,
  });
  signature.addReference({ xpath: `//*[@Id='${MANIFEST_ID}']`, transforms: [EXCLUSIVE_C14N], digestAlgorithm: SHA384, type: `${SIGNATURE_NAMESPACE}Manifest` });
  signature.addReference({
    xpath: `//*[@Id='${PROPERTIES_ID}']`,
    transforms: [EXCLUSIVE_C14N],
    digestAlgorithm: SHA384,
    type: `${SIGNATURE_NAMESPACE}SignatureProperties`,
  });
  signature.computeSignature(serializeDocumentBinding(labelXml, [...parts.keys()]), {
    attrs: { Id: SIGNATURE_ID },
    location: { reference: '/*', action: 'prepend' },
  });
  return signature.getSignedXml();
}

// Verifies a document label binding against the certificate the policy
// service signs with. Only a binding as signedDocumentBinding writes it counts:
// the signature and the MetadataBinding it covers, nothing beside them; the
// signature's algorithms alone, the configured certificate rather than the
// one in KeyInfo, and references to the MetadataBinding, the Manifest and the
// signing time. The package parts the signed Manifest names are then digested
// again.
export function verifyDocumentBinding(bindingXml: string, parts: ReadonlyMap<string, Uint8Array>, certificate: string): BindingVerification {
  const parsed = parseXml(bindingXml);
  if (!parsed.ok) {
    return bindingAltered('The binding is not well-formed XML');
  }
  const signature = childrenNamed(parsed.root, SIGNATURE_NAMESPACE, 'Signature')[0];
  if (signature === undefined) {
    return { status: 'unsigned' };
  }
  if (!holdsOnlySignedContent(parsed.root)) {
    return bindingAltered('The binding holds what its signature does not cover');
  }
  const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
  verifier.SignatureAlgorithms = { [ECDSA_SHA256]: EcdsaSha256 };
  verifier.HashAlgorithms = { [SHA384]: Sha384 };
  const expectedReferences = [DOCUMENT_BINDING_ID, MANIFEST_ID, PROPERTIES_ID].map((id) => `#${id}`);
  const holds = signatureHolds(verifier, signature.toString(), bindingXml);
  const manifest = holds ? signedManifest(verifier.getSignedReferences()) : null;
  if (manifest === null || verifier.getReferences().map((reference) => reference.uri).join(' ') !== expectedReferences.join(' ')) {
    return bindingAltered('The signature does not hold');
  }
  const changedParts = childrenNamed(manifest, SIGNATURE_NAMESPACE, 'Reference').flatMap((reference) => {
    const uri = reference.getAttribute('URI') ?? '';
    const name = packPartName(uri);
    const part = name === null ? null : (parts.get(name) ?? null);
    const method = childrenNamed(reference, SIGNATURE_NAMESPACE, 'DigestMethod')[0]?.getAttribute('Algorithm');
    const digest = childrenNamed(reference, SIGNATURE_NAMESPACE, 'DigestValue')[0]?.textContent?.trim();
    return method === SHA384 && part !== null && sha384(part) === digest ? [] : [name ?? uri];
  });
  return changedParts.length === 0 ? { status: 'valid' } : { status: 'altered', reason: 'Parts changed since signing', changedParts };
}

export function bindingAltered(reason: AlterationReason): BindingVerification {
  return { status: 'altered', reason, changedParts: [] };
}

// Whether a signed binding holds the elements signedDocumentBinding writes and
// no other: first the signature, with its signed info, its value, the signing
// certificate and one object holding the Manifest and the signing time; then
// one container of the MetadataBinding the signature references. Anything else,
// a label a reader could take for the document's included, is unsigned.
function holdsOnlySignedContent(root: Element): boolean {
  const [signature, container, ...rest] = childElements(root);
  const [binding, ...otherBindings] = container === undefined ? [] : childElements(container);
  const [signedInfo, value, keyInfo, object, ...otherSignatureElements] = signature === undefined ? [] : childElements(signature);
  const [certificateData, ...otherKeys] = keyInfo === undefined ? [] : childElements(keyInfo);
  const [certificates, ...otherCertificateData] = certificateData === undefined ? [] : childElements(certificateData);
  const [manifest, properties, ...otherObjects] = object === undefined ? [] : childElements(object);
  return (
    [rest, otherBindings, otherSignatureElements, otherKeys, otherCertificateData, otherObjects].every((extra) => extra.length === 0) &&
    certificates !== undefined &&
    childElements(certificates).length === 0 &&
    isElement(signature, SIGNATURE_NAMESPACE, 'Signature') &&
    isElement(container, BINDING_NAMESPACE, 'MetadataBindingContainer') &&
    isElement(binding, BINDING_NAMESPACE, 'MetadataBinding', DOCUMENT_BINDING_ID) &&
    isElement(signedInfo, SIGNATURE_NAMESPACE, 'SignedInfo') &&
    isElement(value, SIGNATURE_NAMESPACE, 'SignatureValue') &&
    isElement(keyInfo, SIGNATURE_NAMESPACE, 'KeyInfo') &&
    isElement(certificateData, SIGNATURE_NAMESPACE, 'X509Data') &&
    isElement(certificates, SIGNATURE_NAMESPACE, 'X509Certificate') &&
    isElement(object, SIGNATURE_NAMESPACE, 'Object') &&
    isElement(manifest, SIGNATURE_NAMESPACE, 'Manifest', MANIFEST_ID) &&
    isElement(properties, SIGNATURE_NAMESPACE, 'SignatureProperties', PROPERTIES_ID)
  );
}

function isElement(element: Element | undefined, namespace: string, localName: string, id: string | null = null): boolean {
  return element?.namespaceURI === namespace && element.localName === localName && (id === null || element.getAttribute('Id') === id);
}

// xml-crypto throws on a signature value that does not verify, and answers
// false on a reference whose digest does not match. It gets the signature as
// XML: it parses with its own version of xmldom.
function signatureHolds(verifier: SignedXml, signatureXml: string, bindingXml: string): boolean {
  try {
    verifier.loadSignature(signatureXml);
    return verifier.checkSignature(bindingXml);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }
}

// The Manifest among the references a verified signature covers, as signed.
function signedManifest(signedReferences: readonly string[]): Element | null {
  for (const xml of signedReferences) {
    const parsed = parseXml(xml);
    if (parsed.ok && parsed.root.namespaceURI === SIGNATURE_NAMESPACE && parsed.root.localName === 'Manifest') {
      return parsed.root;
    }
  }
  return null;
}
