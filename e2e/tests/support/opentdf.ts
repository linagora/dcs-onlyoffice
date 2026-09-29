import type { Page } from '@playwright/test';
import type { DemoAccount } from './accounts.ts';
import { DOMAIN, deploymentSetting } from './deployment.ts';
import { field, stringField } from './json.ts';

export const PLATFORM = `https://tdf.${DOMAIN}`;
export const IDP = `https://idp.${DOMAIN}`;

export interface ConnectAnswer {
  status: number;
  body: unknown;
}

// The portal never hands a token to the browser, so the test asks the local IdP
// for one with the password grant, which only the local IdP allows. The request
// comes from a page of the IdP's origin, which needs no CORS.
export async function requestAccessToken(page: Page, account: DemoAccount): Promise<string | null> {
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

export interface BaseKey {
  kasUri: string | null;
  kid: string | null;
  algorithm: string | null;
}

// The KAS key that new envelopes wrap their key for, as the platform's
// well-known configuration publishes it, read from a page of the portal's
// origin.
export async function platformBaseKey(page: Page): Promise<BaseKey> {
  const configuration = await page.evaluate(async (platform) => {
    const body: unknown = await (await fetch(`${platform}/.well-known/opentdf-configuration`)).json();
    return body;
  }, PLATFORM);
  const baseKey = field(configuration, 'base_key');
  const publicKey = field(baseKey, 'public_key');
  return { kasUri: stringField(baseKey, 'kas_uri'), kid: stringField(publicKey, 'kid'), algorithm: stringField(publicKey, 'algorithm') };
}

// Calls OpenTDF directly, as a Connect unary call in JSON, from a page of the
// portal's origin, which OpenTDF's CORS settings let through.
export async function callPlatform(page: Page, method: string, token: string | null, body: unknown = {}): Promise<ConnectAnswer> {
  return page.evaluate(
    async ({ platform, method, token, body }) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
      if (token !== null) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`${platform}/${method}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    { platform: PLATFORM, method, token, body },
  );
}
