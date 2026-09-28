import { DEMO_ACCOUNTS, signedInPage } from './support/accounts.ts';
import { browserFetch, openDocument, openNewDocument } from './support/documents.ts';
import { type DocxInspection, type HeaderFooter, pageMarkingTexts, parsedTag } from './support/docx.ts';
import { expect, test } from './support/fixtures.ts';
import { stringField } from './support/json.ts';
import { markedText } from './support/marker.ts';
import { addCustomXmlParts, holdPanelCommands, pluginFrame, pluginPanel, restoreEditorCommands, rewordPageMarking } from './support/plugin.ts';
import { forceSavedDocx, insertPortion, leaveAndWaitForSave } from './support/portions.ts';

const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
// A new document counts as NON PROTÉGÉ: once it holds a DIFFUSION RESTREINTE
// portion, its label says so, in the demo SPIF's colour for NON PROTÉGÉ.
const NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS = 'NON PROTÉGÉ – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
const NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS_CODE = 'DEMO-FR:1/3.1';
const NON_PROTEGE_COLOR = '2E7D32';
// The demo template has a default header and footer of its own, and no
// first-page or even-page ones.
const TEMPLATE_HEADER = 'Exercise NORTHWIND 26 - fictional';
const TEMPLATE_FOOTER = 'Fictional document for demonstration purposes';
const EVERY_HEADER_AND_FOOTER = ['footer default', 'footer even', 'footer first', 'header default', 'header even', 'header first'];

// The page marking that opens the first section's default header.
function defaultHeaderMarking(docx: DocxInspection): unknown {
  return docx.headersAndFooters.find((part) => part.kind === 'header' && part.type === 'default')?.blocks[0] ?? null;
}

// A header's or footer's blocks, with the tags of content controls parsed.
function blocksOf(part: HeaderFooter): unknown[] {
  return part.blocks.map((block) => ('control' in block ? { ...block, control: { ...block.control, tag: parsedTag(block.control.tag) } } : block));
}

test('after an insertion, the page marking opens every header and closes every footer, where authors cannot edit it', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');

  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph under a page marking') });

  const docx = await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS));
  expect(docx.headersAndFooters.map((part) => `${part.kind} ${part.type}`).sort()).toEqual(EVERY_HEADER_AND_FOOTER);
  const marking = {
    control: {
      alias: 'Page marking',
      tag: { v: 1, kind: 'page-marking', label: NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS_CODE },
      lock: 'sdtContentLocked',
      text: NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS,
    },
    color: NON_PROTEGE_COLOR,
  };
  for (const part of docx.headersAndFooters) {
    const own = part.type === 'default' ? [{ paragraph: part.kind === 'header' ? TEMPLATE_HEADER : TEMPLATE_FOOTER }] : [];
    expect(blocksOf(part), `${part.kind} ${part.type}`).toEqual(part.kind === 'header' ? [marking, ...own] : [...own, marking]);
  }
});

test('the page marking follows the base label', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const panel = pluginPanel(page);

  for (const marking of [DIFFUSION_RESTREINTE, SPECIAL_FRANCE]) {
    await panel.getByLabel('Base label').selectOption({ label: marking });
    const docx = await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === marking));
    expect(pageMarkingTexts(docx)).toEqual(EVERY_HEADER_AND_FOOTER.map(() => marking));
  }
});

// Documents labelled before page markings existed hold their document label's
// parts only.
test('a labelled document without its page marking gets it from an author', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  const computed = await browserFetch(page, '/api/policy/policies/DEMO-FR/document-label', 'POST', { base: 'DEMO-FR:2', portions: [] });
  const bindingXml = stringField(JSON.parse(computed.body.toString('utf8')), 'xml');
  if (bindingXml === null) {
    throw new Error('The policy service gave no binding');
  }

  await addCustomXmlParts(await pluginFrame(page), [
    bindingXml,
    '<dcs:document xmlns:dcs="urn:linagora:dcs:document:1" base="DEMO-FR:2" label="DEMO-FR:2"/>',
  ]);

  const docx = await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === DIFFUSION_RESTREINTE));
  expect(pageMarkingTexts(docx)).toEqual(EVERY_HEADER_AND_FOOTER.map(() => DIFFUSION_RESTREINTE));
});

test('a co-author who opens the saved document changes nothing in it', async ({ page, browser }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await insertPortion(page, { marking: DIFFUSION_RESTREINTE, text: markedText('Fictional paragraph saved under its page marking') });
  await leaveAndWaitForSave([page], documentId, 1);
  const bob = await signedInPage(browser, DEMO_ACCOUNTS.bob);

  await openDocument(bob, documentId);
  await expect(pluginPanel(bob).getByTestId('document-label-marking')).toHaveText(NON_PROTEGE_WITH_MORE_RESTRICTIVE_PORTIONS);
  // Two rereads of the document, after which a stale page marking would have
  // been written again.
  await bob.waitForTimeout(7_000);

  const forceSave = await browserFetch(bob, `/documents/${documentId}/forcesave`, 'POST');
  expect(stringField(JSON.parse(forceSave.body.toString('utf8')), 'outcome')).toBe('no-changes');
  await bob.context().close();
});

test('a page marking changed by hand is written again', async ({ page }) => {
  const documentId = await openNewDocument(page, 'exercise-northwind.docx');
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: DIFFUSION_RESTREINTE });
  await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === DIFFUSION_RESTREINTE));
  const frame = await pluginFrame(page);

  // The words change in the stored file before the panel can see them.
  await holdPanelCommands(frame);
  try {
    await rewordPageMarking(frame, 'NON PROTÉGÉ');
    await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).includes('NON PROTÉGÉ'));
  } finally {
    await restoreEditorCommands(frame);
  }

  const docx = await forceSavedDocx(page, documentId, (saved) => pageMarkingTexts(saved).every((text) => text === DIFFUSION_RESTREINTE));
  expect(pageMarkingTexts(docx)).toEqual(EVERY_HEADER_AND_FOOTER.map(() => DIFFUSION_RESTREINTE));
  expect(defaultHeaderMarking(docx)).toMatchObject({ control: { lock: 'sdtContentLocked' } });
});
