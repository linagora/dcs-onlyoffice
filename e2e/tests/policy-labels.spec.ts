import { DEMO_ACCOUNTS, type DemoAccount } from './support/accounts.ts';
import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';

const EVERY_MARKING = [
  'NON PROTÉGÉ',
  'DIFFUSION RESTREINTE',
  'DIFFUSION RESTREINTE – SPÉCIAL FRANCE',
  'DIFFUSION RESTREINTE – DIFFUSION OTAN',
];

test('the labelling panel offers alice, cleared for every label, every label of the demo SPIF', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  await expect(pluginPanel(page).getByTestId('label-marking')).toHaveText(EVERY_MARKING);
});

// An author never writes what they could not read; the base label describes
// the document's unprotected content, so it keeps every choice.
const OFFERED: [DemoAccount, string[]][] = [
  [DEMO_ACCOUNTS.bob, ['NON PROTÉGÉ', 'DIFFUSION RESTREINTE', 'DIFFUSION RESTREINTE – DIFFUSION OTAN']],
  [DEMO_ACCOUNTS.chloe, ['NON PROTÉGÉ']],
];
for (const [account, markings] of OFFERED) {
  test.describe(`signed in as ${account.login}`, () => {
    test.use({ account });

    test('new portions offer only the labels the clearance allows, and the base label every label', async ({ page }) => {
      await openDocument(page, 'exercise-northwind');

      const panel = pluginPanel(page);
      await expect(panel.getByTestId('label-marking')).toHaveText(markings);
      await expect(panel.getByLabel('Base label').locator('option')).toHaveText(EVERY_MARKING);
    });
  });
}

test.describe('signed in as dan', () => {
  test.use({ account: DEMO_ACCOUNTS.dan });

  test('someone whose clearance allows no label is told so rather than offered an empty choice', async ({ page }) => {
    await openDocument(page, 'exercise-northwind');

    const panel = pluginPanel(page);
    await expect(panel.getByTestId('no-allowed-label')).toHaveText('Your clearance allows no label, so you cannot write protected portions.');
    await expect(panel.getByRole('radio')).toHaveCount(0);
    await expect(panel.getByLabel('Base label').locator('option')).toHaveText(EVERY_MARKING);
    // Nor does the editor's Insert tab offer to insert one.
    const editor = page.frameLocator('iframe[name="frameEditor"]');
    await editor.getByText('Insert', { exact: true }).first().click();
    await expect(editor.getByRole('button', { name: /^Protected\s*portion$/ })).toHaveCount(0);
  });
});

test('the portal relays policy requests only for signed-in users', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  const status = await page.evaluate(async () => {
    const signedIn = await fetch('/api/policy/policies', { credentials: 'same-origin' });
    const anonymous = await fetch('/api/policy/policies', { credentials: 'omit' });
    return { signedIn: signedIn.status, anonymous: anonymous.status };
  });
  expect(status).toEqual({ signedIn: 200, anonymous: 401 });
});

// A path starting with "//" after the relay prefix would name another host.
test('the policy relay reaches no other host than the policy service', async ({ page }) => {
  const answer = await page.evaluate(async () => {
    const response = await fetch('/api/policy//portal:3000/healthz', { credentials: 'same-origin' });
    return { status: response.status, body: await response.text() };
  });
  expect(answer.body).not.toContain('"status":"ok"');
  expect(answer.status).toBe(404);
});
