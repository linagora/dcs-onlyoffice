import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';

// A KAS key for hpqt:secp384r1-mlkem1024, ECDH P-384 combined with
// ML-KEM-1024 (id-MLKEM1024-ECDH-P384 of draft-ietf-lamps-pq-composite-kem-14),
// in the formats of the platform's lib/ocrypto, which the KAS reads.

// The key registry's name for hpqt:secp384r1-mlkem1024.
export const HYBRID_KEY_ALGORITHM = 'ALGORITHM_HPQT_SECP384R1_MLKEM1024';

// 1.3.6.1.5.5.7.6.63 and 1.3.132.0.34
const COMPOSITE_OID = Uint8Array.of(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x06, 0x3f);
const SECP384R1_OID = Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x22);
const NONCE_LENGTH = 12;

export interface KeyPairPem {
  publicPem: string;
  privatePem: string;
}

// The public key holds the ML-KEM encapsulation key, then the uncompressed EC
// point; the private key holds the 64-byte ML-KEM seed, then an RFC 5915
// ECPrivateKey. Both carry the composite OID alone as their algorithm.
export async function generateHybridKeyPair(): Promise<KeyPairPem> {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const { publicKey: mlkemPublicKey } = ml_kem1024.keygen(seed);
  const ec = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', ec.publicKey));
  const { d } = await crypto.subtle.exportKey('jwk', ec.privateKey);
  if (d === undefined) {
    throw new Error('The EC private key could not be exported');
  }
  const ecPrivateKey = der(0x30, [
    der(0x02, Uint8Array.of(1)),
    der(0x04, Buffer.from(d, 'base64url')),
    der(0xa0, der(0x06, SECP384R1_OID)),
    der(0xa1, der(0x03, Uint8Array.of(0, ...point))),
  ]);
  const algorithm = der(0x30, der(0x06, COMPOSITE_OID));
  const publicKey = der(0x30, [algorithm, der(0x03, Uint8Array.of(0, ...mlkemPublicKey, ...point))]);
  const privateKey = der(0x30, [der(0x02, Uint8Array.of(0)), algorithm, der(0x04, Uint8Array.of(...seed, ...ecPrivateKey))]);
  return { publicPem: pem('PUBLIC KEY', publicKey), privatePem: pem('PRIVATE KEY', privateKey) };
}

// How the KAS reads a private key from its registry: AES-256-GCM with the
// root key, the 12-byte nonce before the ciphertext and its tag, in base64.
export async function wrapWithRootKey(text: string, rootKey: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', rootKey, 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(text)));
  return Buffer.concat([nonce, sealed]).toString('base64');
}

// Whether the root key opens a private key wrapped as above.
export async function isWrappedWithRootKey(wrapped: string, rootKey: Uint8Array): Promise<boolean> {
  const bytes = Buffer.from(wrapped, 'base64');
  const key = await crypto.subtle.importKey('raw', rootKey, 'AES-GCM', false, ['decrypt']);
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, NONCE_LENGTH) }, key, bytes.subarray(NONCE_LENGTH));
    return true;
  } catch {
    return false;
  }
}

// Short and long form lengths up to two bytes, which the keys never exceed.
function der(tag: number, content: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(content) ? Buffer.concat(content) : content;
  if (body.length > 0xffff) {
    throw new Error('DER content longer than 65,535 bytes');
  }
  const length =
    body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Uint8Array.of(tag, ...length, ...body);
}

function pem(label: string, bytes: Uint8Array): string {
  const lines = Buffer.from(bytes).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
