import { playDemo } from '../demo/scenario.ts';
import { DEMO_ACCOUNTS, signedInPage } from '../tests/support/accounts.ts';
import { test } from '../tests/support/fixtures.ts';
import { unmarkedText } from '../tests/support/marker.ts';
import { capture, captureTopOfPage, screenshotPath } from './screenshots.ts';

/*
 * The screenshots of the demo's walkthrough (docs/walkthrough.md), taken as
 * the README's are, by the scenario the CI replays. Every portion text is
 * fictional and carries no marker, which would show in the screenshots.
 *
 * Run it on a fresh stack, as the README's screenshots, which pnpm --filter
 * @dcs/e2e captures takes first: its home page then lists few documents, and
 * shows the upload form. The screenshots land in docs/screenshots/walkthrough.
 */

const WALKTHROUGH_SCREENSHOTS = new URL('../../docs/screenshots/walkthrough/', import.meta.url);

// alice, whom the fixture signs in, is the French officer.
test('screenshots of the walkthrough', async ({ page, browser }) => {
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await playDemo(
      { alice: page, bob },
      {
        capture: (shown, name) => capture(shown, screenshotPath(WALKTHROUGH_SCREENSHOTS, name)),
        captureTopOfPage: (shown, name) => captureTopOfPage(shown, screenshotPath(WALKTHROUGH_SCREENSHOTS, name)),
        text: unmarkedText,
      },
    );
  } finally {
    await bob.context().close();
  }
});
