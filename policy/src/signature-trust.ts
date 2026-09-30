import { verify, X509Certificate } from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import { CertificateList } from '@peculiar/asn1-x509';

// The digest of each signature algorithm a revocation list may be signed
// with: ECDSA or RSA, with SHA-2.
const REVOCATION_LIST_DIGESTS: ReadonlyMap<string, string> = new Map([
  ['1.2.840.10045.4.3.2', 'sha256'],
  ['1.2.840.10045.4.3.3', 'sha384'],
  ['1.2.840.10045.4.3.4', 'sha512'],
  ['1.2.840.113549.1.1.11', 'sha256'],
  ['1.2.840.113549.1.1.12', 'sha384'],
  ['1.2.840.113549.1.1.13', 'sha512'],
]);

// Why the certificate a binding signature was made with is not trusted.
export type DistrustReason =
  | 'The signing certificate is not trusted'
  | 'The signing certificate was revoked'
  | "The signature was made outside its certificate's validity";

// A certificate authority a deployment trusts to issue signing certificates,
// and the serial numbers of those its revocation lists revoke.
export interface TrustedAuthority {
  certificate: X509Certificate;
  revoked: ReadonlySet<string>;
}

// What binding signatures are trusted by: the certificate authorities a
// deployment configures; or, when it configures none, the one certificate
// the policy service signs with, as before authorities could be configured.
export type SignatureTrust = { kind: 'authorities'; authorities: readonly TrustedAuthority[] } | { kind: 'signing-certificate'; certificate: X509Certificate };

// The trust a deployment configures, from the certificate the policy service
// signs with, the certificates of the authorities it trusts and their
// revocation lists, all as PEM, several certificates or lists one after the
// other, empty for none. It throws rather than trust signatures that
// the service would make and then report: a signing certificate that no
// trusted authority issued, that one revoked, or that is outside its
// validity `now`. It throws on a revocation list that no trusted authority
// signed, which would revoke nothing.
export function signatureTrust(signingCertificate: string, trustAnchors: string, revocationLists: string, now: Date): SignatureTrust {
  const signer = new X509Certificate(signingCertificate);
  const authorities = pemBlocks(trustAnchors, 'CERTIFICATE', 'The binding trust anchors hold no certificate').map((der) => ({
    certificate: new X509Certificate(der),
    revoked: new Set<string>(),
  }));
  for (const der of pemBlocks(revocationLists, 'X509 CRL', 'The binding revocation lists hold no CRL')) {
    const list = readRevocationList(der);
    const issuer = authorities.find((authority) => list.signedBy(authority.certificate));
    if (issuer === undefined) {
      throw new Error('No trusted authority signed a binding revocation list');
    }
    for (const serialNumber of list.serialNumbers) {
      issuer.revoked.add(serialNumber);
    }
  }
  if (authorities.length === 0) {
    return { kind: 'signing-certificate', certificate: signer };
  }
  const issuer = issuerOf(signer, authorities);
  if (issuer === null) {
    throw new Error('No trusted authority issued the binding signing certificate');
  }
  if (issuer.revoked.has(serialNumberOf(signer))) {
    throw new Error('A binding revocation list revokes the binding signing certificate');
  }
  if (now < signer.validFromDate || now > signer.validToDate) {
    throw new Error('The binding signing certificate is outside its validity');
  }
  return { kind: 'authorities', authorities };
}

// Why a signature made at `signingTime` with `certificate` is not trusted,
// null when it is: a trusted authority issued the certificate and did not
// revoke it, and the signature was made within the certificate's validity.
// Revocation counts whenever it happened: the signing time is the signer's
// own word, which a stolen key would give as it pleases.
export function distrustOf(certificate: X509Certificate, signingTime: Date | null, trust: SignatureTrust): DistrustReason | null {
  if (trust.kind === 'signing-certificate') {
    return certificate.fingerprint256 === trust.certificate.fingerprint256 ? null : 'The signing certificate is not trusted';
  }
  const issuer = issuerOf(certificate, trust.authorities);
  if (issuer === null) {
    return 'The signing certificate is not trusted';
  }
  if (issuer.revoked.has(serialNumberOf(certificate))) {
    return 'The signing certificate was revoked';
  }
  if (signingTime === null || signingTime < certificate.validFromDate || signingTime > certificate.validToDate) {
    return "The signature was made outside its certificate's validity";
  }
  return null;
}

// The trusted authority that issued a certificate, as its name and its
// signature tell, null when none did. The authority issues signing
// certificates itself: a deployment trusts an intermediate authority by
// configuring its certificate.
function issuerOf(certificate: X509Certificate, authorities: readonly TrustedAuthority[]): TrustedAuthority | null {
  return authorities.find((authority) => certificate.checkIssued(authority.certificate) && certificate.verify(authority.certificate.publicKey)) ?? null;
}

// A certificate's serial number as serialNumberFrom gives it.
function serialNumberOf(certificate: X509Certificate): string {
  return serialNumberFrom(certificate.serialNumber);
}

// A serial number in hexadecimal as certificates and revocation lists are
// compared: in upper case, without the leading zeros an encoding may add.
function serialNumberFrom(hex: string): string {
  return hex.toUpperCase().replace(/^0+(?=.)/, '');
}

// The DER content of each PEM block of that label in a text, which must hold
// one at least unless it is empty.
function pemBlocks(text: string, label: string, noneError: string): Buffer[] {
  const blocks = Array.from(text.matchAll(new RegExp(`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`, 'g')), (match) =>
    Buffer.from(match[1] ?? '', 'base64'),
  );
  if (blocks.length === 0 && text.trim() !== '') {
    throw new Error(noneError);
  }
  return blocks;
}

// What a certificate revocation list says, and a check of who signed it.
interface RevocationList {
  serialNumbers: string[];
  signedBy: (authority: X509Certificate) => boolean;
}

// A certificate revocation list, read as its issuer signed it: the list is
// written again from what was read and compared with the signed bytes, so
// that nothing the parser missed goes unnoticed. The parser drops the
// revoked certificates of a list without a next update, for one; RFC 5280
// requires the next update of every list.
function readRevocationList(der: Uint8Array): RevocationList {
  const list = AsnConvert.parse(der, CertificateList);
  const signed = firstElementOf(der);
  if (!Buffer.from(AsnConvert.serialize(list.tbsCertList)).equals(signed)) {
    throw new Error('A binding revocation list could not be read as its issuer signed it');
  }
  const digest = REVOCATION_LIST_DIGESTS.get(list.signatureAlgorithm.algorithm);
  if (digest === undefined) {
    throw new Error(`A binding revocation list is signed with an algorithm the policy service does not support: ${list.signatureAlgorithm.algorithm}`);
  }
  const signature = new Uint8Array(list.signature);
  return {
    serialNumbers: (list.tbsCertList.revokedCertificates ?? []).map((entry) => serialNumberFrom(Buffer.from(entry.userCertificate).toString('hex'))),
    signedBy: (authority) => verify(digest, signed, authority.publicKey, signature),
  };
}

// The first element of a DER SEQUENCE, as encoded: for a revocation list, the
// part its signature covers. Tags are one byte long, and lengths definite.
function firstElementOf(der: Uint8Array): Uint8Array {
  const outer = contentOf(der, 0);
  return der.subarray(outer.start, contentOf(der, outer.start).end);
}

// Where the content of the DER element at `offset` lies.
function contentOf(der: Uint8Array, offset: number): { start: number; end: number } {
  const first = der[offset + 1] ?? 0;
  const count = first < 0x80 ? 0 : first & 0x7f;
  let length = first < 0x80 ? first : 0;
  for (const byte of der.subarray(offset + 2, offset + 2 + count)) {
    length = length * 256 + byte;
  }
  const start = offset + 2 + count;
  return { start, end: start + length };
}
