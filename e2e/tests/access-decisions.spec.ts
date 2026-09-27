import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, type DemoAccount } from './support/accounts.ts';
import { expect, test } from './support/fixtures.ts';
import { arrayField, field } from './support/json.ts';
import { callPlatform, requestAccessToken } from './support/opentdf.ts';

const GET_DECISIONS = 'authorization.v2.AuthorizationService/GetDecisionMultiResource';

interface Clearance {
  classification: string;
  categories: string[];
}

// The policy service decides for the clearance it is given, while OpenTDF reads
// the clearance directory: the test gives each account's clearance in the demo
// seed (deploy/directory/seeds/demo.json) as the directory grants it today.
// dan has none, and erin's has ended.
const CLEARANCES: { account: DemoAccount; clearance: Clearance | null }[] = [
  {
    account: DEMO_ACCOUNTS.alice,
    clearance: { classification: 'DIFFUSION RESTREINTE', categories: ['Special Handling:SPECIAL FRANCE', 'Releasable To:NATO'] },
  },
  { account: DEMO_ACCOUNTS.bob, clearance: { classification: 'DIFFUSION RESTREINTE', categories: ['Releasable To:NATO'] } },
  { account: DEMO_ACCOUNTS.chloe, clearance: { classification: 'NON PROTEGE', categories: [] } },
  { account: DEMO_ACCOUNTS.dan, clearance: null },
  { account: DEMO_ACCOUNTS.erin, clearance: null },
];

// The rollup indicator, which document labels carry: the informative category
// MORE RESTRICTIVE PORTIONS (lacv 1) of the tag set Composition (arc 3).
const ROLLUP_INDICATOR = '/3.1';

// The labels of the demo policy each account may read, by code: NON PROTÉGÉ,
// DIFFUSION RESTREINTE, the same with SPÉCIAL FRANCE, and released to NATO,
// each also with the rollup indicator, which grants and refuses nothing.
const READABLE: Record<string, string[]> = {
  alice: ['DEMO-FR:1', 'DEMO-FR:1/3.1', 'DEMO-FR:2', 'DEMO-FR:2/1.1', 'DEMO-FR:2/1.1/3.1', 'DEMO-FR:2/2.1', 'DEMO-FR:2/2.1/3.1', 'DEMO-FR:2/3.1'],
  bob: ['DEMO-FR:1', 'DEMO-FR:1/3.1', 'DEMO-FR:2', 'DEMO-FR:2/2.1', 'DEMO-FR:2/2.1/3.1', 'DEMO-FR:2/3.1'],
  chloe: ['DEMO-FR:1', 'DEMO-FR:1/3.1'],
  dan: [],
  erin: [],
};

// Calls the policy service through the portal's relay, as the plugin does.
async function callPolicy(page: Page, path: string, body: unknown = null): Promise<unknown> {
  const answer = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(`/api/policy${path}`, {
        method: body === null ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body === null ? null : JSON.stringify(body),
      });
      const json: unknown = await response.json();
      return { status: response.status, body: json };
    },
    { path, body },
  );
  expect(answer.status).toBe(200);
  return answer.body;
}

// Every valid label: those offered to authors, and the same as document labels.
async function labelCodes(page: Page): Promise<string[]> {
  const answer = await callPolicy(page, '/policies/DEMO-FR/labels');
  const offered = (Array.isArray(answer) ? answer : []).map((label: unknown) => String(field(label, 'code')));
  return [...offered, ...offered.map((code) => `${code}${ROLLUP_INDICATOR}`)];
}

async function attributesOf(page: Page, code: string): Promise<string[]> {
  return arrayField(await callPolicy(page, '/policies/DEMO-FR/labels/attributes', { code }), 'attributes').map(String);
}

// The labels OpenTDF lets the account read, asked with the account's own token.
async function readableForOpentdf(page: Page, account: DemoAccount, attributes: Map<string, string[]>): Promise<string[]> {
  const token = await requestAccessToken(page, account);
  const answer = await callPlatform(page, GET_DECISIONS, token, {
    entityIdentifier: { withRequestToken: true },
    action: { name: 'read' },
    resources: [...attributes].map(([code, fqns]) => ({ ephemeralId: code, attributeValues: { fqns } })),
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return arrayField(answer.body, 'resourceDecisions')
    .filter((decision) => field(decision, 'decision') === 'DECISION_PERMIT')
    .map((decision) => String(field(decision, 'ephemeralResourceId')))
    .sort();
}

async function readableForPolicy(page: Page, clearance: Clearance | null, codes: string[]): Promise<string[]> {
  const readable: string[] = [];
  for (const code of codes) {
    if (field(await callPolicy(page, '/policies/DEMO-FR/access-decision', { code, clearance }), 'granted') === true) {
      readable.push(code);
    }
  }
  return readable.sort();
}

test("OpenTDF's decision is the security policy's access decision for every account and label", async ({ page }) => {
  const codes = await labelCodes(page);
  const attributes = new Map<string, string[]>();
  for (const code of codes) {
    attributes.set(code, await attributesOf(page, code));
  }
  const opentdf: Record<string, string[]> = {};
  const policy: Record<string, string[]> = {};

  for (const { account, clearance } of CLEARANCES) {
    opentdf[account.login] = await readableForOpentdf(page, account, attributes);
    policy[account.login] = await readableForPolicy(page, clearance, codes);
  }

  expect(opentdf).toEqual(policy);
  expect(policy).toEqual(READABLE);
});
