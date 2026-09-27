import type { Frame, Page } from '@playwright/test';
import { DEMO_ACCOUNTS, type DemoAccount, signedInPage } from './support/accounts.ts';
import { deploymentSetting } from './support/deployment.ts';
import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginFrame } from './support/plugin.ts';

const DOMAIN = process.env.DOMAIN ?? 'dcs.test';
const PLATFORM = `https://tdf.${DOMAIN}`;
const IDP = `https://idp.${DOMAIN}`;

// The portal never hands a token to the browser, so the test asks the local IdP
// for one with the password grant, which only the local IdP allows. The request
// comes from a page of the IdP's origin, which needs no CORS.
async function requestAccessToken(page: Page, account: DemoAccount): Promise<string | null> {
  const idpPage = await page.context().newPage();
  await idpPage.goto(`${IDP}/.well-known/openid-configuration`);
  const accessToken = await idpPage.evaluate(
    async (request) => {
      const response = await fetch('/oauth2/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${request.clientId}:${request.clientSecret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'password',
          username: request.username,
          password: request.password,
          scope: 'openid profile email groups',
        }),
      });
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null && 'access_token' in body && typeof body.access_token === 'string'
        ? body.access_token
        : null;
    },
    {
      clientId: deploymentSetting('OIDC_CLIENT_ID'),
      clientSecret: deploymentSetting('OIDC_CLIENT_SECRET'),
      username: account.login,
      password: account.password,
    },
  );
  await idpPage.close();
  return accessToken;
}

test('the OpenTDF platform answers on its own host name', async ({ page }) => {
  const health = await page.evaluate(async (platform) => {
    const response = await fetch(`${platform}/healthz`);
    const body: unknown = await response.json();
    return { status: response.status, body };
  }, PLATFORM);

  expect(health).toEqual({ status: 200, body: { status: 'SERVING' } });
});

// The platform is called from the portal's origin, as the plugin will call it:
// the test also proves that the platform's CORS settings let the browser through.
test('the OpenTDF platform trusts access tokens from the IdP and rejects anonymous calls', async ({ page, account }) => {
  const accessToken = await requestAccessToken(page, account);
  expect(accessToken).not.toBeNull();

  const statuses = await page.evaluate(
    async ({ platform, token }) => {
      const listNamespaces = async (headers: Record<string, string>): Promise<number> => {
        const response = await fetch(`${platform}/policy.namespaces.NamespaceService/ListNamespaces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers },
          body: '{}',
        });
        return response.status;
      };
      return {
        withToken: await listNamespaces({ Authorization: `Bearer ${token}` }),
        withoutToken: await listNamespaces({}),
      };
    },
    { platform: PLATFORM, token: accessToken },
  );

  expect(statuses).toEqual({ withToken: 200, withoutToken: 401 });
});

test('the portal hands no access token to the browser', async ({ page }) => {
  const status = await page.evaluate(async () => (await fetch('/api/token', { credentials: 'same-origin' })).status);

  expect(status).toBe(404);
});

interface ConnectAnswer {
  status: number;
  body: unknown;
}

interface RelayRequest {
  method: string;
  // Whether the call carries the Connect protocol header the web SDK sends.
  connect: boolean;
  // A token the browser would add itself.
  authorization: string | null;
  signedIn: boolean;
}

const SDK_CALL = { connect: true, authorization: null, signedIn: true } as const;

const LIST_KAS = 'policy.kasregistry.KeyAccessServerRegistryService/ListKeyAccessServers';

// Calls the portal's OpenTDF relay as the web SDK does: a Connect unary call,
// in JSON, from a page of the portal's origin.
async function callRelay(target: Page | Frame, request: RelayRequest): Promise<ConnectAnswer> {
  return target.evaluate(async ({ method, connect, authorization, signedIn }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (connect) {
      headers['Connect-Protocol-Version'] = '1';
    }
    if (authorization !== null) {
      headers.Authorization = authorization;
    }
    const response = await fetch(`/api/opentdf/${method}`, {
      method: 'POST',
      credentials: signedIn ? 'same-origin' : 'omit',
      headers,
      body: '{}',
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
    return { status: response.status, body };
  }, request);
}

// Calls OpenTDF directly with a token, as the relay should.
async function callPlatform(page: Page, method: string, token: string | null): Promise<ConnectAnswer> {
  return page.evaluate(
    async ({ platform, method, token }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
      if (token !== null) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`${platform}/${method}`, { method: 'POST', headers, body: '{}' });
      return { status: response.status, body: await response.json() };
    },
    { platform: PLATFORM, method, token },
  );
}

test("the portal relays the plugin's OpenTDF calls with the signed-in person's token", async ({ page, account }) => {
  await openDocument(page, 'exercise-northwind');
  const frame = await pluginFrame(page);
  const direct = await callPlatform(page, LIST_KAS, await requestAccessToken(page, account));

  // A token sent by the browser is never the one that reaches OpenTDF.
  const relayed = await callRelay(frame, { ...SDK_CALL, method: LIST_KAS, authorization: 'Bearer not-a-token' });

  expect(direct.status).toBe(200);
  expect(relayed).toEqual(direct);
});

test('the relay refuses other calls, calls without the Connect protocol and anonymous callers', async ({ page }) => {
  expect(await callRelay(page, { ...SDK_CALL, method: 'policy.namespaces.NamespaceService/ListNamespaces' })).toMatchObject({ status: 404 });
  expect(await callRelay(page, { ...SDK_CALL, method: LIST_KAS, connect: false })).toMatchObject({ status: 415 });
  expect(await callRelay(page, { ...SDK_CALL, method: LIST_KAS, signedIn: false })).toMatchObject({ status: 401 });
});

// A token issued now expires after the portal's first tokens: once OpenTDF
// refuses it, a relayed call only succeeds with a refreshed token. Waiting
// that long covers the IdP's token lifetime and OpenTDF's clock skew.
test('once access tokens expire, the relay renews them, unless the person has signed out of the IdP', async ({ page, account, browser }) => {
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    expect(await callRelay(page, { ...SDK_CALL, method: LIST_KAS })).toMatchObject({ status: 200 });
    expect(await callRelay(bob, { ...SDK_CALL, method: LIST_KAS })).toMatchObject({ status: 200 });
    const witness = await requestAccessToken(page, account);
    await bob.goto(`${IDP}/?logout=1`);

    await expect
      .poll(async () => (await callPlatform(page, LIST_KAS, witness)).status, { timeout: 200_000, intervals: [5_000] })
      .toBe(401);

    expect(await callRelay(page, { ...SDK_CALL, method: LIST_KAS })).toMatchObject({ status: 200 });
    await bob.goto('/healthz');
    expect(await callRelay(bob, { ...SDK_CALL, method: LIST_KAS })).toMatchObject({ status: 401 });
    await bob.goto('/');
    await expect(bob).toHaveURL(/\/\/idp\./);
  } finally {
    await bob.context().close();
  }
});
