import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { documentLogEntries, portalLog } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { pageMarkingTexts } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import {
  addFootnote,
  addToParagraph,
  commentOnParagraph,
  insertTable,
  pluginFrame,
  pluginPanel,
  selectParagraphs,
  selectUntilParagraph,
  trackChanges,
} from './support/plugin.ts';
import { forceSavedDocx, placeholderLinks } from './support/portions.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const SPECIAL_FRANCE_CODE = 'DEMO-FR:2/1.1';
const WITH_MORE_RESTRICTIVE_PORTIONS = 'DIFFUSION RESTREINTE – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// Paragraphs of the template, by their position among its body's elements:
// its purpose, its schedule, its logistics and its points of contact. Their
// texts went through ONLYOFFICE in clear, which the tests protect, and which
// therefore carry no portion marker.
const PURPOSE = {
  position: 4,
  text: 'This note sets out the coordination arrangements for Exercise NORTHWIND 26, a fictional multinational command post exercise held over five days.',
};
const SCHEDULE = {
  position: 8,
  text: 'Deployment on day 1, command post activities from day 2 to day 4, recovery and after-action review on day 5.',
};
const LOGISTICS = {
  position: 10,
  text: 'Accommodation, rations and transport are provided by the host nation cell. Requests must reach the control cell ten days before deployment.',
};
const CONTACT = 12;
const WARNING =
  "The selected content already went through ONLYOFFICE in clear: it is protected from now on only, and copies made before, such as the editor's working files of this session, keep it.";

test('the French officer protects a paragraph already written, which becomes a SPECIAL FRANCE portion the allied officer cannot read', async ({
  page,
  browser,
}) => {
  const since = new Date();
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  await panel.getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await expect(panel.getByTestId('document-label-marking')).toHaveText(DIFFUSION_RESTREINTE);

  await selectParagraphs(await pluginFrame(page), LOGISTICS.position, LOGISTICS.position);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('button', { name: 'Protect the selection' }).click();
  const confirmation = panel.getByTestId('protection-confirmation');
  await expect(confirmation.getByTestId('protection-warning')).toHaveText(WARNING);
  await expect(confirmation.getByTestId('protection-preview')).toHaveText(LOGISTICS.text);
  await confirmation.getByRole('button', { name: 'Protect the selection' }).click();

  await expect(panel.getByTestId('portion-text')).toHaveText([LOGISTICS.text]);
  await expect(panel.getByTestId('document-label-marking')).toHaveText(WITH_MORE_RESTRICTIVE_PORTIONS);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);
  try {
    await openDocument(bob, documentId);
    await expect(pluginPanel(bob).getByTestId('portion-notice')).toHaveText('Access denied');
  } finally {
    await bob.context().close();
  }
  const saved = await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 1);
  expect(saved.portionParts[0]).toMatchObject({ label: SPECIAL_FRANCE_CODE, encoding: 'ztdf' });
  const placeholder = `${SPECIAL_FRANCE} – protected portion`;
  expect(saved.contentControls).toEqual([
    {
      alias: 'Protected portion',
      tag: expect.any(String),
      lock: 'sdtContentLocked',
      text: placeholder,
      links: placeholderLinks({ documentId, portionId: saved.portionParts[0]?.id ?? '' }, placeholder),
    },
  ]);
  // The block stands where the paragraph stood, between the headings around it.
  expect(saved.bodyText).toContain(`4. Logistics\n${SPECIAL_FRANCE} – protected portion\n5. Points of contact`);
  expect(saved.allText).not.toContain('host nation cell');
  expect(pageMarkingTexts(saved).every((text) => text === WITH_MORE_RESTRICTIVE_PORTIONS)).toBe(true);
  const portionId = saved.portionParts[0]?.id;
  await expect
    .poll(() => documentLogEntries(since, 'Existing content protected in the panel', documentId))
    .toEqual([expect.objectContaining({ portion: portionId, after: { label: SPECIAL_FRANCE_CODE, version: 1 }, user: 'alice' })]);
  expect(portalLog(since)).not.toContain('host nation cell');
});

test('paragraphs that hold a table, part of a portion, a comment or a note, or that changed since the panel read them, are refused', async ({
  page,
}) => {
  await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  const editor = page.frameLocator('iframe[name="frameEditor"]');
  const protect = panel.getByRole('button', { name: 'Protect the selection' });
  const confirmation = panel.getByTestId('protection-confirmation');
  const failure = panel.getByTestId('protection-failure');
  const frame = await pluginFrame(page);

  // The context menu protects the paragraph that holds the cursor.
  await editor.locator('#editor_sdk').click({ position: { x: 400, y: 300 }, button: 'right' });
  await editor.getByText('Protect the selection', { exact: true }).click();
  await expect(confirmation.getByTestId('protection-preview')).toHaveText(/\S/);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();

  // A paragraph that the selection only touches, at its very start, counts out.
  await selectUntilParagraph(frame, PURPOSE.position, PURPOSE.position + 1);
  await protect.click();
  await expect(confirmation.getByTestId('protection-preview')).toHaveText(PURPOSE.text);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();

  await selectParagraphs(frame, SCHEDULE.position, SCHEDULE.position);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await protect.click();
  await addToParagraph(frame, SCHEDULE.position, ' Fictional addition by a co-author.');
  await confirmation.getByRole('button', { name: 'Protect the selection' }).click();
  await expect(failure).toHaveText('The selected content changed since the panel read it, so nothing was protected: protect it again.');
  await expect(panel.getByTestId('portion-item')).toHaveCount(0);

  await insertTable(frame, CONTACT);
  await selectParagraphs(frame, CONTACT - 1, CONTACT + 1);
  await protect.click();
  await expect(failure).toHaveText('The selection holds a table: select paragraphs of text only.');

  await commentOnParagraph(frame, LOGISTICS.position, 'Fictional comment on the arrangements');
  await selectParagraphs(frame, LOGISTICS.position, LOGISTICS.position);
  await protect.click();
  await expect(failure).toHaveText('The selected paragraphs hold a comment, which would stay in clear: delete it or select other paragraphs.');

  await addFootnote(frame, SCHEDULE.position, 'Fictional note on the schedule');
  // The editor leaves the note it opened once the author clicks the body.
  await editor.locator('#editor_sdk').click({ position: { x: 400, y: 300 } });
  await selectParagraphs(frame, SCHEDULE.position, SCHEDULE.position);
  await protect.click();
  await expect(failure).toHaveText('The selected paragraphs hold a footnote or an endnote, which would be lost: delete it or select other paragraphs.');

  // The portion's block goes after the paragraph that holds the selection.
  await selectParagraphs(frame, PURPOSE.position, PURPOSE.position);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('textbox', { name: 'Portion text' }).fill(markedText('Fictional portion that no protection covers'));
  await panel.getByRole('button', { name: 'Insert protected portion' }).click();
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);
  await selectParagraphs(frame, PURPOSE.position, PURPOSE.position + 2);
  await protect.click();
  await expect(failure).toHaveText('The selection holds part of a portion, a page marking or another content control: select other paragraphs.');
  await expect(panel.getByTestId('portion-item')).toHaveCount(1);
});

test('a paragraph protected while changes are tracked leaves the document, with no tracked deletion that would keep its text', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);
  const frame = await pluginFrame(page);
  await trackChanges(frame, true);

  await selectParagraphs(frame, SCHEDULE.position, SCHEDULE.position);
  await panel.getByRole('radio', { name: SPECIAL_FRANCE, exact: true }).check();
  await panel.getByRole('button', { name: 'Protect the selection' }).click();
  await panel.getByTestId('protection-confirmation').getByRole('button', { name: 'Protect the selection' }).click();

  await expect(panel.getByTestId('portion-text')).toHaveText([SCHEDULE.text]);
  const saved = await forceSavedDocx(page, documentId, (docx) => docx.portionParts.length === 1);
  expect(saved.allText).not.toContain('after-action review');
  expect(saved.allText).not.toContain('<w:del ');
});
