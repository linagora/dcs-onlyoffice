import { type BinaryLike, createHash, createPrivateKey, createPublicKey, type KeyLike, KeyObject, sign, verify } from 'node:crypto';
import { type HashAlgorithm, type SignatureAlgorithm, SignedXml } from 'xml-crypto';
import { escapeXml } from './adatp4774.ts';
import { BINDING_NAMESPACE, packUri, serializeDocumentBinding } from './adatp4778.ts';

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

// The key and certificate the policy service signs bindings with, as PEM.
export interface BindingSigner {
  privateKey: string;
  certificate: string;
}

class Sha384 implements HashAlgorithm {
  getHash(xml: string): string {
    return createHash('sha384').update(xml, 'utf8').digest('base64');
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
  const references = Array.from(parts, ([name, bytes]) => {
    const digest = createHash('sha384').update(bytes).digest('base64');
    return `<Reference URI="${escapeXml(packUri(name))}"><DigestMethod Algorithm="${SHA384}"/><DigestValue>${digest}</DigestValue></Reference>`;
  });
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
