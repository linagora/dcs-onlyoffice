import { openDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { editorFrame, pluginPanel } from './support/plugin.ts';

// Requests the Document Server's service worker makes would escape the
// routes that stand for the ad blocker.
test.use({ serviceWorkers: 'block' });

// Ad blockers block any script named like an analytics one: ONLYOFFICE's
// editors load such a module as they start, and never start without it. The
// test also runs on Firefox, where a demo user met the failure.
test('the editor opens behind an ad blocker that blocks analytics scripts', { tag: '@cross-browser' }, async ({ page }) => {
  await page.route(/analytics/i, async (route) => route.abort('blockedbyclient'));

  await openDocument(page, 'exercise-northwind');

  await expect(pluginPanel(page).getByTestId('identity-name')).toHaveText('Alice Martin');
  // The blocker does block the module under ONLYOFFICE's own name for it.
  const underOriginalName = await editorFrame(page).evaluate(async () => {
    try {
      await fetch(new URL('../../common/Analytics.js', location.href));
      return 'fetched';
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        return 'blocked';
      }
      throw error;
    }
  });
  expect(underOriginalName).toBe('blocked');
});
