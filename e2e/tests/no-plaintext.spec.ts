import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { canaryText, markedText, PORTION_MARKER } from './support/marker.ts';
import { insertUnencryptedPortion, labelXmlOf, pluginFrame } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, shownPortions } from './support/portions.ts';
import { tracesIn } from './support/traces.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';

// Every frame the page's editor exchanges with the Document Server over its
// websocket, from now on.
function recordEditorFrames(page: Page): Buffer[] {
  const frames: Buffer[] = [];
  page.on('websocket', (socket) => {
    const keep = (frame: { payload: string | Buffer }): void => {
      frames.push(typeof frame.payload === 'string' ? Buffer.from(frame.payload, 'utf8') : frame.payload);
    };
    socket.on('framesent', keep);
    socket.on('framereceived', keep);
  });
  return frames;
}

// The iteration's exit criterion: the Document Server never sees a portion's
// text. The CI also searches its working files once the suite is over. An
// unencrypted portion, written as before encryption, sends its canary text
// the way an envelope travels: finding it proves that the search sees that
// way. Text typed into the document body travels one character at a time,
// which only the saved file shows.
test('no portion text reaches the Document Server, in the co-editing exchanges or the saved file', async ({ page, browser }) => {
  const aliceFrames = recordEditorFrames(page);
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  const bobFrames = recordEditorFrames(bob);
  await openDocument(bob, documentId);
  const aliceText = markedText('Fictional French-eyes-only paragraph');
  const bobText = markedText('Fictional allied paragraph');

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: aliceText });
  await insertPortion(bob, { marking: RELEASABLE_TO_NATO, text: bobText });
  const canary = canaryText('Fictional unencrypted paragraph');
  const frame = await pluginFrame(page);
  const labelXml = await labelXmlOf(frame, 'DEMO-FR', 'DEMO-FR:1');
  await insertUnencryptedPortion(frame, { labelCode: 'DEMO-FR:1', labelXml, placeholder: 'NON PROTÉGÉ – protected portion', text: canary });

  // Both portions reached both authors, so the exchanges carried them.
  await expect
    .poll(async () => (await shownPortions(page)).map((portion) => portion.text))
    .toEqual([bobText, aliceText, canary]);
  await expect
    .poll(async () => (await shownPortions(bob)).map((portion) => portion.text))
    .toEqual([bobText, null, canary]);
  await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 3);
  const saved = await browserFetch(page, `/documents/${documentId}/download`);
  await bob.context().close();

  const frames = [...aliceFrames, ...bobFrames];
  const framesHolding = async (texts: string[]): Promise<string[]> =>
    (await Promise.all(frames.map((frame, index) => tracesIn(frame, `frame ${index}`, texts)))).flat();
  expect(await framesHolding([canary])).not.toEqual([]);
  expect(await tracesIn(saved.body, 'saved DOCX', [canary])).not.toEqual([]);
  const secrets = [aliceText, bobText, PORTION_MARKER];
  expect(await framesHolding(secrets)).toEqual([]);
  expect(await tracesIn(saved.body, 'saved DOCX', secrets)).toEqual([]);
});
