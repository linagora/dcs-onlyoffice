import { test } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from '../tests/support/accounts.ts';
import { unmarkedText } from '../tests/support/marker.ts';
import { playDemo } from './scenario.ts';

// Each person's browser, at the size of the videos.
const SIZE = { width: 1280, height: 800 };

// The demo, replayed as docs/walkthrough.md tells it, with a video of the
// French officer's browser and one of the allied officer's: alice.webm and
// bob.webm, in this test's folder of test-results/demo. A step that fails
// fails the replay, and the videos stop there. The portion texts carry no
// marker, which would show in the videos.
test('the demo, replayed with a video of each person', async ({ browser }, testInfo) => {
  const recording = { viewport: SIZE, recordVideo: { dir: testInfo.outputPath('recording'), size: SIZE } };
  const people = {
    alice: await signedInPage(browser, DEMO_ACCOUNTS.alice, recording),
    bob: await signedInPage(browser, DEMO_ACCOUNTS.bob, recording),
  };
  try {
    await playDemo(people, { capture: async () => {}, captureTopOfPage: async () => {}, text: unmarkedText });
  } finally {
    for (const [name, page] of Object.entries(people)) {
      await page.context().close();
      const video = page.video();
      await video?.saveAs(testInfo.outputPath(`${name}.webm`));
      await video?.delete();
    }
  }
});
