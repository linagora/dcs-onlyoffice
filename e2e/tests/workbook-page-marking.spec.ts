import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { storeDocument } from './support/deployment.ts';
import { openDocument, openNewDocument } from './support/documents.ts';
import { expect, test } from './support/fixtures.ts';
import { markedText } from './support/marker.ts';
import { pluginPanel } from './support/plugin.ts';
import { forceSavedXlsx, storedFile } from './support/portions.ts';
import { addSheet, insertWorkbookPortion } from './support/workbooks.ts';
import { everySheetShows, HEADER_FOOTER_NAMES } from './support/xlsx.ts';

const WORKBOOK_TEMPLATE = 'exercise-northwind-logistics.xlsx';
const DIFFUSION_RESTREINTE = 'DIFFUSION RESTREINTE';
const SPECIAL_FRANCE = 'DIFFUSION RESTREINTE – SPÉCIAL FRANCE';
const RELEASABLE_TO_NATO = 'DIFFUSION RESTREINTE – DIFFUSION OTAN';
// The demo policy's longest marking: a document released to NATO that holds
// a more restrictive portion.
const LONGEST_MARKING = 'DIFFUSION RESTREINTE – DIFFUSION OTAN – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// The centre sections that show those markings, bold and in the colour the
// demo policy gives them, E8590C.
const DIFFUSION_RESTREINTE_CENTRE = '&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE';
const RELEASABLE_TO_NATO_CENTRE = '&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE – DIFFUSION OTAN';
const LONGEST_CENTRE = '&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE – DIFFUSION OTAN – CONTIENT DES PORTIONS PLUS RESTRICTIVES';
// The template's header and footer, once marked DIFFUSION RESTREINTE: its
// left and right sections stay.
const DIFFUSION_RESTREINTE_HEADER = '&LExercise NORTHWIND 26 - fictional&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE';
const DIFFUSION_RESTREINTE_FOOTER = '&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE&RFictional workbook';
// Microsoft Excel's limit for each header and footer string, codes included.
const EXCEL_LIMIT = 255;

async function labelledWorkbook(page: Page, marking: string): Promise<string> {
  const documentId = await openNewDocument(page, WORKBOOK_TEMPLATE);
  await pluginPanel(page).getByLabel('Base label').selectOption({ label: marking });
  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(marking);
  return documentId;
}

test("once a workbook has a base label, each sheet's six headers and footers show its marking in their centre, and keep the template's sections", async ({ page }) => {
  const documentId = await labelledWorkbook(page, DIFFUSION_RESTREINTE);

  const saved = await forceSavedXlsx(page, documentId, (xlsx) => everySheetShows(xlsx, DIFFUSION_RESTREINTE_CENTRE));

  expect(saved.worksheets.map((sheet) => sheet.headersAndFooters)).toEqual([
    {
      strings: {
        oddHeader: DIFFUSION_RESTREINTE_HEADER,
        oddFooter: DIFFUSION_RESTREINTE_FOOTER,
        evenHeader: DIFFUSION_RESTREINTE_HEADER,
        evenFooter: DIFFUSION_RESTREINTE_FOOTER,
        firstHeader: DIFFUSION_RESTREINTE_HEADER,
        firstFooter: DIFFUSION_RESTREINTE_FOOTER,
      },
      differentFirst: true,
      differentOddEven: true,
    },
  ]);
});

test('a sheet added in the editor gets the page marking', async ({ page }) => {
  const documentId = await labelledWorkbook(page, DIFFUSION_RESTREINTE);

  await addSheet(page, 'Convoys');

  const saved = await forceSavedXlsx(page, documentId, (xlsx) => xlsx.worksheets.length === 2 && everySheetShows(xlsx, DIFFUSION_RESTREINTE_CENTRE));
  expect(saved.worksheets[1]?.headersAndFooters.strings.oddHeader).toBe(DIFFUSION_RESTREINTE_CENTRE);
});

test("a page marking altered in the stored file is written again by the next author's panel", async ({ page }) => {
  const labelled = await labelledWorkbook(page, DIFFUSION_RESTREINTE);
  await forceSavedXlsx(page, labelled, (xlsx) => everySheetShows(xlsx, DIFFUSION_RESTREINTE_CENTRE));
  const zip = await JSZip.loadAsync(await storedFile(page, labelled));
  const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
  zip.file('xl/worksheets/sheet1.xml', sheet.replaceAll('DIFFUSION RESTREINTE', 'NON PROTÉGÉ'));
  const documentId = `workbook-altered-marking-${randomBytes(4).toString('hex')}`;
  await storeDocument(documentId, await zip.generateAsync({ type: 'uint8array' }), '.xlsx');

  await openDocument(page, documentId);

  await forceSavedXlsx(page, documentId, (xlsx) => everySheetShows(xlsx, DIFFUSION_RESTREINTE_CENTRE));
});

test('the page marking follows the document label, and stays within 255 characters with the longest marking', async ({ page }) => {
  const documentId = await labelledWorkbook(page, RELEASABLE_TO_NATO);
  await forceSavedXlsx(page, documentId, (xlsx) => everySheetShows(xlsx, RELEASABLE_TO_NATO_CENTRE));

  await insertWorkbookPortion(page, { marking: SPECIAL_FRANCE, text: markedText('Fictional portion that lengthens the marking') }, 'F4:G4');

  await expect(pluginPanel(page).getByTestId('document-label-marking')).toHaveText(LONGEST_MARKING);
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => everySheetShows(xlsx, LONGEST_CENTRE));
  const lengths = saved.worksheets.flatMap((sheet) => HEADER_FOOTER_NAMES.map((name) => sheet.headersAndFooters.strings[name]?.length ?? 0));
  expect(Math.max(...lengths)).toBeLessThanOrEqual(EXCEL_LIMIT);
});

test('a section too long to fit beside the marking within 255 characters gives way to it', async ({ page }) => {
  const labelled = await labelledWorkbook(page, DIFFUSION_RESTREINTE);
  await forceSavedXlsx(page, labelled, (xlsx) => everySheetShows(xlsx, DIFFUSION_RESTREINTE_CENTRE));
  // A 200-character left section, and a right one of its own.
  const left = 'Fictional long left section '.repeat(8).slice(0, 200);
  const zip = await JSZip.loadAsync(await storedFile(page, labelled));
  const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
  zip.file(
    'xl/worksheets/sheet1.xml',
    sheet.replace(/<oddHeader>[^<]*<\/oddHeader>/, `<oddHeader>&amp;L${left}&amp;C&amp;"-,Bold"&amp;KE8590CDIFFUSION RESTREINTE&amp;RFictional right section</oddHeader>`),
  );
  const documentId = `workbook-long-header-${randomBytes(4).toString('hex')}`;
  await storeDocument(documentId, await zip.generateAsync({ type: 'uint8array' }), '.xlsx');
  await openDocument(page, documentId);

  await pluginPanel(page).getByLabel('Base label').selectOption({ label: RELEASABLE_TO_NATO });

  // With the left section, even alone, the header would exceed 255
  // characters: it gives way, and the right one fits beside the marking.
  const saved = await forceSavedXlsx(page, documentId, (xlsx) => everySheetShows(xlsx, RELEASABLE_TO_NATO_CENTRE));
  expect(saved.worksheets[0]?.headersAndFooters.strings.oddHeader).toBe(`${RELEASABLE_TO_NATO_CENTRE}&RFictional right section`);
});
