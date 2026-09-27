import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { breakEditorCommands, pluginFrame, pluginInfoIdentity, pluginPanel, restoreEditorCommands } from './support/plugin.ts';

test('the labelling panel opens with the document and shows who is signed in', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  const panel = pluginPanel(page);
  await expect(panel.getByTestId('identity-name')).toHaveText('Alice Martin');
  await expect(panel.getByTestId('identity-account')).toHaveText('alice');
});

// Undocumented behaviour 1: where the plugin page comes from.
test('the plugin iframe is served from the portal origin', { tag: '@cross-browser' }, async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  const frame = await pluginFrame(page);
  test.info().annotations.push({ type: 'plugin iframe URL', description: frame.url() });
  expect(new URL(frame.url()).origin).toBe(new URL(page.url()).origin);
});

// Undocumented behaviour 2: calls from the panel to the portal carry the session.
test('the portal session cookie is sent from the plugin iframe', { tag: '@cross-browser' }, async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  const frame = await pluginFrame(page);
  const identity = await frame.evaluate(async () => {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    const body: unknown = response.ok ? await response.json() : null;
    return { status: response.status, body };
  });
  expect(identity).toEqual({ status: 200, body: expect.objectContaining({ id: 'alice' }) });
});

// Undocumented behaviour 3: whether the editor tells the plugin who the user is.
test('the editor exposes the user identity to the plugin', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');

  const frame = await pluginFrame(page);
  await expect(pluginPanel(page).getByTestId('identity-name')).toBeVisible();
  const identity = await pluginInfoIdentity(frame);
  test.info().annotations.push({ type: 'Asc.plugin.info identity', description: JSON.stringify(identity) });
  expect(identity).toEqual({ userId: 'alice', userName: 'Alice Martin' });
});

test('the panel warns while the document cannot be reread, until a reread succeeds', async ({ page }) => {
  await openDocument(page, 'exercise-northwind');
  const panel = pluginPanel(page);
  await expect(panel.getByTestId('identity-name')).toHaveText('Alice Martin');
  const frame = await pluginFrame(page);

  await breakEditorCommands(frame, 'Fictional editor failure');
  await expect(panel.getByTestId('reread-warning')).toContainText('Fictional editor failure');

  await restoreEditorCommands(frame);
  await expect(panel.getByTestId('reread-warning')).toHaveCount(0);
});
