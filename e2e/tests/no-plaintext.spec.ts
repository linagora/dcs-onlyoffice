import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { canaryText, markedText, PORTION_MARKER } from './support/marker.ts';
import { bubble, insertUnencryptedPortion, labelXmlOf, pluginFrame, pluginPanel } from './support/plugin.ts';
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

// Every message the editor's page receives from now on, the plugin's
// included: the page that runs ONLYOFFICE's code, on the Document Server's
// origin.
async function recordEditorMessages(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    if (window.name !== 'frameEditor') {
      return;
    }
    const received: string[] = [];
    Object.assign(window, { dcsReceivedMessages: received });
    window.addEventListener(
      'message',
      (event) => {
        received.push(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
      },
      true,
    );
  });
  return async () => {
    const frame = page.frames().find((candidate) => candidate.name() === 'frameEditor');
    const received: unknown = await frame?.evaluate(() => Reflect.get(window, 'dcsReceivedMessages'));
    return Array.isArray(received) ? received.map(String) : [];
  };
}

// The iteration's exit criterion: the Document Server never sees a portion's
// text. The CI also searches its working files once the suite is over. An
// unencrypted portion, written as before encryption, sends its canary text
// the way an envelope travels: finding it proves that the search sees that
// way. Text typed into the document body travels one character at a time,
// which only the saved file shows.
test('no portion text reaches the Document Server, in the co-editing exchanges or the saved file', async ({ page, browser }) => {
  const aliceFrames = recordEditorFrames(page);
  const readAliceMessages = await recordEditorMessages(page);
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  const bobFrames = recordEditorFrames(bob);
  await openDocument(bob, documentId);
  const aliceText = markedText('Fictional French-eyes-only paragraph');
  const bobText = markedText('Fictional allied paragraph');

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: aliceText });
  // Bob's insertion counts the portions of his panel: Alice's must be there
  // first.
  await expect(pluginPanel(bob).getByTestId('portion-item')).toHaveCount(1);
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
  // Nor does the window that shows the portion holding the cursor send its
  // text through the editor's page.
  const alicePortion = pluginPanel(page).getByTestId('portion-item').filter({ hasText: aliceText });
  await alicePortion.getByRole('button').first().click();
  await expect(bubble(page).getByTestId('bubble-text')).toHaveText(aliceText);

  // Nor does a change: its new text travels as a new envelope.
  const changedText = markedText('Fictional French-eyes-only paragraph, changed');
  await alicePortion.getByRole('button', { name: 'Change', exact: true }).click();
  await alicePortion.getByRole('textbox', { name: 'Portion text' }).fill(changedText);
  await alicePortion.getByRole('button', { name: 'Save the change' }).click();
  await expect
    .poll(async () => (await shownPortions(page)).map((portion) => portion.text))
    .toEqual([bobText, changedText, canary]);
  await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 3);
  const saved = await browserFetch(page, `/documents/${documentId}/download`);
  await bob.context().close();

  const frames = [...aliceFrames, ...bobFrames];
  const framesHolding = async (texts: string[]): Promise<string[]> =>
    (await Promise.all(frames.map((frame, index) => tracesIn(frame, `frame ${index}`, texts)))).flat();
  expect(await framesHolding([canary])).not.toEqual([]);
  expect(await tracesIn(saved.body, 'saved DOCX', [canary])).not.toEqual([]);
  const secrets = [aliceText, changedText, bobText, PORTION_MARKER];
  expect(await framesHolding(secrets)).toEqual([]);
  const messages = await readAliceMessages();
  // The recording saw the panel ask the editor's page to open the bubble.
  expect(messages.filter((message) => message.includes('ShowWindow'))).not.toEqual([]);
  const messagesHolding = (
    await Promise.all(messages.map((message, index) => tracesIn(Buffer.from(message, 'utf8'), `message ${index}`, secrets)))
  ).flat();
  expect(messagesHolding).toEqual([]);
  expect(await tracesIn(saved.body, 'saved DOCX', secrets)).toEqual([]);
});
