import { generateHybridKeyPair, HYBRID_KEY_ALGORITHM, isWrappedWithRootKey, wrapWithRootKey } from './hybrid-key.ts';
import type { OpentdfPlatform, PlatformKasKey } from './platform.ts';

export interface KasKeySettings {
  // The KAS address that the platform registers and that envelopes name.
  kasUri: string;
  keyId: string;
  // The key registry's root key, which the KAS unwraps private keys with.
  rootKey: Uint8Array;
}

export interface KasKeyChanges {
  kas: number;
  keys: number;
  baseKey: number;
}

// Makes a hybrid post-quantum key the base key of the KAS: the SDK wraps the
// key of every new envelope for it. A key that exists is never replaced, since
// envelopes name it.
export async function applyKasKey(platform: OpentdfPlatform, settings: KasKeySettings): Promise<KasKeyChanges> {
  const changes: KasKeyChanges = { kas: 0, keys: 0, baseKey: 0 };
  let kasId = await platform.kasId(settings.kasUri);
  if (kasId === null) {
    kasId = await platform.registerKas(settings.kasUri);
    changes.kas += 1;
  }
  const existing = await platform.kasKey(kasId, settings.keyId);
  if (existing === null) {
    const pair = await generateHybridKeyPair();
    await platform.createRootKeyWrappedKey({
      kasId,
      keyId: settings.keyId,
      algorithm: HYBRID_KEY_ALGORITHM,
      publicPem: pair.publicPem,
      wrappedPrivateKey: await wrapWithRootKey(pair.privatePem, settings.rootKey),
    });
    changes.keys += 1;
  } else {
    await checkKeptKey(existing, settings.rootKey);
  }
  const current = await platform.baseKey();
  if (current?.keyId !== settings.keyId || current.kasUri !== settings.kasUri) {
    await platform.setBaseKey(kasId, settings.keyId);
    changes.baseKey += 1;
  }
  return changes;
}

// A key from an earlier run must still be a hybrid key that the root key
// unwraps: with another root key, the KAS could not read any envelope.
async function checkKeptKey(key: PlatformKasKey, rootKey: Uint8Array): Promise<void> {
  if (key.algorithm !== HYBRID_KEY_ALGORITHM) {
    throw new Error(`the KAS key ${key.keyId} is ${key.algorithm}, not ${HYBRID_KEY_ALGORITHM}`);
  }
  if (key.wrappedPrivateKey === null || !(await isWrappedWithRootKey(key.wrappedPrivateKey, rootKey))) {
    throw new Error(`the root key does not unwrap the KAS key ${key.keyId}: it is not the root key the key was created with`);
  }
}
