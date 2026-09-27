import { DEMO_ACCOUNTS } from './support/accounts.ts';
import { expect, test } from './support/fixtures.ts';
import { callPlatform, requestAccessToken } from './support/opentdf.ts';

const CREATE_ENTITY_CHAINS = 'entityresolution.v2.EntityResolutionService/CreateEntityChainsFromTokens';

interface ResolvedClearance {
  classifications: string[];
  categories: string[];
}

// The clearance claims of each chain OpenTDF resolved, by the chain's id.
function resolvedClearances(body: unknown): Record<string, ResolvedClearance> {
  const resolved: Record<string, ResolvedClearance> = {};
  const chains: unknown[] = typeof body === 'object' && body !== null && 'entityChains' in body && Array.isArray(body.entityChains) ? body.entityChains : [];
  for (const chain of chains) {
    if (typeof chain !== 'object' || chain === null || !('ephemeralId' in chain) || typeof chain.ephemeralId !== 'string' || !('entities' in chain)) {
      continue;
    }
    const entity: unknown = Array.isArray(chain.entities) ? chain.entities[0] : null;
    const claims: unknown =
      typeof entity === 'object' && entity !== null && 'claims' in entity && typeof entity.claims === 'object' && entity.claims !== null && 'value' in entity.claims
        ? entity.claims.value
        : null;
    resolved[chain.ephemeralId] = { classifications: stringsOf(claims, 'classifications'), categories: stringsOf(claims, 'categories') };
  }
  return resolved;
}

// Lists read in sorted order: the directory keeps no order.
function stringsOf(claims: unknown, name: string): string[] {
  if (typeof claims !== 'object' || claims === null || !(name in claims)) {
    return [];
  }
  const value: unknown = (claims as Record<string, unknown>)[name]; // SAFETY: object checked above
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').sort() : [];
}

test("OpenTDF resolves each person's clearance from the clearance directory", async ({ page }) => {
  const accounts = [DEMO_ACCOUNTS.alice, DEMO_ACCOUNTS.bob, DEMO_ACCOUNTS.chloe, DEMO_ACCOUNTS.dan, DEMO_ACCOUNTS.erin];
  const tokens = [];
  for (const account of accounts) {
    tokens.push({ ephemeralId: account.login, jwt: await requestAccessToken(page, account) });
  }
  // Resolving someone else's entity is an administrator's call.
  const administrator = await requestAccessToken(page, DEMO_ACCOUNTS.alice);

  const answer = await callPlatform(page, CREATE_ENTITY_CHAINS, administrator, { tokens });

  expect(answer.status).toBe(200);
  expect(resolvedClearances(answer.body)).toEqual({
    alice: {
      classifications: ['DEMO-FR:DIFFUSION RESTREINTE'],
      categories: ['DEMO-FR:Releasable To:NATO', 'DEMO-FR:Special Handling:SPECIAL FRANCE'],
    },
    bob: { classifications: ['DEMO-FR:DIFFUSION RESTREINTE'], categories: ['DEMO-FR:Releasable To:NATO'] },
    chloe: { classifications: ['DEMO-FR:NON PROTEGE'], categories: [] },
    dan: { classifications: [], categories: [] },
    erin: { classifications: [], categories: [] },
  });
});
