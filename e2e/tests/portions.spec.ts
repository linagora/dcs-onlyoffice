import { openDocument, openNewDocument } from './support/documents.ts';
import { labelOfXml } from './support/docx.ts';
import { envelopeManifest } from './support/envelopes.ts';
import { expect, test } from './support/fixtures.ts';
import { PLATFORM } from './support/opentdf.ts';
import { insertUnencryptedPortion, labelXmlOf, pluginFrame, pluginPanel } from './support/plugin.ts';
import { fillPortionForm, forceSavedDocx, insertPortion, leaveAndWaitForSave } from './support/portions.ts';

const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('an inserted portion is stored as an envelope and read back in the panel', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional protected paragraph ${Date.now()}`;

  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });

  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-marking')).toHaveText([SPECIAL_FRANCE]);
  await expect(panel.getByTestId('portion-text')).toHaveText([secret]);

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.portionParts.length === 1);
  expect(docx.contentControls).toEqual([
    { alias: 'Protected portion', tag: expect.any(String), lock: 'sdtContentLocked', text: `${SPECIAL_FRANCE} – protected portion` },
  ]);
  const tag: unknown = JSON.parse(docx.contentControls[0]?.tag ?? 'null');
  expect(tag).toEqual({ v: 1, id: expect.stringMatching(UUID), label: 'DEMO-FR:2/1.1' });
  const portionId = (tag as { id: string }).id; // SAFETY: shape asserted just above
  expect(docx.portionParts).toEqual([
    { id: portionId, version: '1', label: 'DEMO-FR:2/1.1', labelXml: expect.any(String), encoding: 'ztdf', content: expect.any(String) },
  ]);
  const part = docx.portionParts[0];
  if (part === undefined) {
    throw new Error('The saved DOCX holds no portion part');
  }
  const portionLabel = labelOfXml(part.labelXml);
  expect(portionLabel).toEqual({
    policy: 'DEMO-FR',
    classification: 'DIFFUSION RESTREINTE',
    categories: [{ type: 'RESTRICTIVE', tagName: 'Special Handling', values: ['SPECIAL FRANCE'] }],
  });

  // The envelope names the stack's KAS, carries the same label, bound to it,
  // and the label's attribute values, which the KAS decides access with.
  const manifest = await envelopeManifest(part);
  expect(manifest.keyAccessUrls).toEqual([`${PLATFORM}/kas`]);
  expect(manifest.dataAttributes).toEqual([
    'https://demo-fr.dcs.linagora.com/attr/classification/value/diffusion-restreinte',
    'https://demo-fr.dcs.linagora.com/attr/special-handling/value/special-france',
  ]);
  expect(manifest.assertions.map((assertion) => assertion.type)).toEqual(['handling']);
  expect(labelOfXml(manifest.assertions[0]?.statement ?? '')).toEqual(portionLabel);

  expect(docx.allText).not.toContain(secret);
  expect(docx.allText).not.toContain(Buffer.from(secret).toString('base64'));
});

// Undocumented behaviour 4: content-control tags and Custom XML parts survive
// the Document Server's DOCX save and a later reopening.
test('portions survive saving to DOCX and reopening', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional reopened paragraph ${Date.now()}`;
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });

  await leaveAndWaitForSave([page], documentId, 1);

  await openDocument(page, documentId);
  await expect(pluginPanel(page).getByTestId('portion-text')).toHaveText([secret]);
  await expect(pluginPanel(page).getByTestId('portion-marking')).toHaveText([SPECIAL_FRANCE]);
});

// One editor command inserts both the block and its part; the panel's regular
// rereading of the document must not add undo steps of its own.
test('a single undo removes an inserted portion and its part', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: `Fictional undone paragraph ${Date.now()}` });
  // Let the panel reread the document a few times.
  await page.waitForTimeout(7_000);

  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('ControlOrMeta+z');

  await expect(pluginPanel(page).getByTestId('portion-item')).toHaveCount(0);
  const docx = await forceSavedDocx(page, documentId, (saved) => saved.contentControls.length === 0);
  expect(docx.portionParts).toEqual([]);
});

test('a portion inserted in the middle of a paragraph goes after it and leaves it whole', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const paragraph = `Fictional paragraph ${Date.now()} ends here`;
  await page.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(paragraph);
  for (const _character of ' ends here') {
    await page.keyboard.press('ArrowLeft');
  }

  const panel = pluginPanel(page);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Portion text' }).fill(`Fictional protected text ${Date.now()}`);
  await panel.getByRole('button', { name: 'Insert protected portion' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);

  const docx = await forceSavedDocx(page, documentId, (saved) => saved.contentControls.length === 1 && saved.bodyText.includes('Fictional paragraph'));
  const lines = docx.bodyText.split('\n');
  const index = lines.indexOf(paragraph);
  expect(index, 'the paragraph stays whole').toBeGreaterThanOrEqual(0);
  expect(lines[index + 1]).toBe(`${SPECIAL_FRANCE} – protected portion`);
});

test('a portion from before encryption is shown with a warning that it is not encrypted', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  const frame = await pluginFrame(page);
  const labelXml = await labelXmlOf(frame, 'DEMO-FR', 'DEMO-FR:2/1.1');
  const text = `Fictional unencrypted paragraph ${Date.now()}`;

  await insertUnencryptedPortion(frame, { labelCode: 'DEMO-FR:2/1.1', labelXml, placeholder: `${SPECIAL_FRANCE} – protected portion`, text });

  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-notice')).toHaveText(['Not encrypted: this portion dates from before encryption.']);
  await expect(panel.getByTestId('portion-text')).toHaveText([text]);
});

test('a portion that cannot be decrypted says why, and is read once it can be', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const secret = `Fictional retried paragraph ${Date.now()}`;
  await insertPortion(page, { marking: SPECIAL_FRANCE, text: secret });
  await leaveAndWaitForSave([page], documentId, 1);

  const relay = '**/api/opentdf/**';
  await page.route(relay, async (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"unavailable","message":"Fictional outage"}' }),
  );
  await openDocument(page, documentId);
  const panel = pluginPanel(page);
  await expect(panel.getByTestId('portion-notice')).toHaveText([/^Could not decrypt \(.+\)\.$/]);

  await page.unroute(relay);
  await expect(panel.getByTestId('portion-text')).toHaveText([secret]);
});

test('a text that cannot be encrypted is not inserted', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const platform = `${PLATFORM}/**`;
  await page.route(platform, async (route) => route.abort());
  const panel = pluginPanel(page);
  await fillPortionForm(page, { marking: SPECIAL_FRANCE, text: `Fictional unsealed paragraph ${Date.now()}` });

  await panel.getByRole('button', { name: 'Insert protected portion' }).click();

  await expect(panel.getByTestId('insertion-failure')).toContainText('The text could not be encrypted, so nothing was inserted');
  await page.unroute(platform);
  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  const docx = await forceSavedDocx(page, documentId, () => true);
  expect(docx.contentControls).toEqual([]);
  expect(docx.portionParts).toEqual([]);
});

// An envelope without attribute values would be handed to anyone signed in.
test('a label that gives no attribute value is not used to encrypt', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const attributes = '**/api/policy/policies/*/labels/attributes';
  await page.route(attributes, async (route) => route.fulfill({ json: { attributes: [] } }));
  const panel = pluginPanel(page);
  await fillPortionForm(page, { marking: SPECIAL_FRANCE, text: `Fictional unrestricted paragraph ${Date.now()}` });

  await panel.getByRole('button', { name: 'Insert protected portion' }).click();

  await expect(panel.getByTestId('insertion-failure')).toContainText('The text could not be encrypted, so nothing was inserted');
  await page.unroute(attributes);
  await expect(panel.getByTestId('portion-item')).toHaveCount(0);
  const docx = await forceSavedDocx(page, documentId, () => true);
  expect(docx.portionParts).toEqual([]);
});

test('the panel refuses a text longer than 20,000 characters', async ({ page }) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  const insert = panel.getByRole('button', { name: 'Insert protected portion' });
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  const textbox = panel.getByRole('textbox', { name: 'Portion text' });

  await textbox.fill('x'.repeat(20_001));
  await expect(panel.getByTestId('text-too-long')).toHaveText('A portion holds at most 20,000 characters.');
  await expect(insert).toBeDisabled();

  await textbox.fill('x'.repeat(20_000));
  await expect(panel.getByTestId('text-too-long')).toHaveCount(0);
  await expect(insert).toBeEnabled();
});
