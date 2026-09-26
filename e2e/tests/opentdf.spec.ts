import { expect, test } from './support/fixtures.ts';

const PLATFORM = `https://tdf.${process.env.DOMAIN ?? 'dcs.test'}`;

test('the OpenTDF platform answers on its own host name', async ({ page }) => {
  const health = await page.evaluate(async (platform) => {
    const response = await fetch(`${platform}/healthz`);
    return { status: response.status, body: (await response.json()) as unknown };
  }, PLATFORM);

  expect(health).toEqual({ status: 200, body: { status: 'SERVING' } });
});

// The call comes from the portal's origin, as the plugin's will: it also proves
// that the platform's CORS settings let the browser through.
test('the OpenTDF platform trusts access tokens from the IdP and rejects anonymous calls', async ({ page }) => {
  const statuses = await page.evaluate(async (platform) => {
    const token = (await (await fetch('/api/token', { credentials: 'same-origin' })).json()) as { accessToken: string };
    const listNamespaces = async (headers: Record<string, string>): Promise<number> => {
      const response = await fetch(`${platform}/policy.namespaces.NamespaceService/ListNamespaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...headers },
        body: '{}',
      });
      return response.status;
    };
    return {
      withToken: await listNamespaces({ Authorization: `Bearer ${token.accessToken}` }),
      withoutToken: await listNamespaces({}),
    };
  }, PLATFORM);

  expect(statuses).toEqual({ withToken: 200, withoutToken: 401 });
});
