import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { pluginPanel } from './support/plugin.ts';

test('the labelling panel lists the labels that the demo SPIF allows', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  await expect(pluginPanel(page).getByTestId('label-marking')).toHaveText([
    'NON PROTÉGÉ',
    'DIFFUSION RESTREINTE',
    'DIFFUSION RESTREINTE – SPÉCIAL FRANCE',
    'DIFFUSION RESTREINTE – DIFFUSION OTAN',
  ]);
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
