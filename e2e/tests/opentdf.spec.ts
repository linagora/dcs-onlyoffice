import type { Page } from '@playwright/test';
import type { DemoAccount } from './support/accounts.ts';
import { deploymentSetting } from './support/deployment.ts';
import { expect, test } from './support/fixtures.ts';

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
