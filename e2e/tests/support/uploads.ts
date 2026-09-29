import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';

export interface UploadedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

// The base label an upload asks for: the label the file carries, the form's
// first option; a label the form offers, by marking; or, as someone altering
// the page could, a code the form does not offer.
export type RequestedLabel = 'carried' | { marking: string } | { code: string };

// Uploads a file through the form of the portal's home page, and gives the
// status of the portal's answer.
export async function upload(page: Page, file: UploadedFile, label: RequestedLabel): Promise<number> {
  await page.goto('/');
  const labels = page.getByLabel('Base label');
  if (label === 'carried') {
    await labels.selectOption('');
  } else if ('code' in label) {
    await labels.evaluate((select, code) => {
      select.append(new Option(code, code));
    }, label.code);
    await labels.selectOption(label.code);
  } else {
    await labels.selectOption({ label: label.marking });
  }
  await page.getByLabel('DOCX file, up to 20 MB').setInputFiles(file);
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/documents/upload'));
  await page.getByRole('button', { name: 'Upload' }).click();
  return (await response).status();
}

// A DOCX with one more Custom XML part of the main document, with its
// properties part, relationships and content type, as another labelling tool
// would write it.
export async function withCustomXmlPart(docx: Buffer, xml: string, namespace: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  let number = 1;
  while (zip.file(`customXml/item${number}.xml`) !== null) {
    number += 1;
  }
  zip.file(`customXml/item${number}.xml`, xml);
  zip.file(
    `customXml/itemProps${number}.xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ds:datastoreItem ds:itemID="{${randomUUID().toUpperCase()}}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="${namespace}"/></ds:schemaRefs></ds:datastoreItem>`,
  );
  zip.file(
    `customXml/_rels/item${number}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps${number}.xml"/></Relationships>`,
  );
  const relationships = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  zip.file(
    'word/_rels/document.xml.rels',
    relationships.replace(
      '</Relationships>',
      `<Relationship Id="rIdTool${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item${number}.xml"/></Relationships>`,
    ),
  );
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  zip.file(
    '[Content_Types].xml',
    types.replace('</Types>', `<Override PartName="/customXml/itemProps${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/></Types>`),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
