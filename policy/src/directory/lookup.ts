import { type Clearance, normalizedEmail } from './clearance.ts';
import type { ClearanceStore } from './store.ts';

// The clearance a person holds now under a policy, if any. An entry grants
// nothing outside its validity period, which OpenTDF's entity resolution
// reads the same way: from its first instant to before its last.
export async function currentClearanceOf(store: ClearanceStore, email: string, policy: string, now: Date): Promise<Clearance | null> {
  const entry = await store.clearanceOf(normalizedEmail(email), policy);
  return entry !== null && entry.validFrom <= now && now < entry.validUntil ? entry : null;
}
