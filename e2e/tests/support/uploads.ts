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

// Fills the form of the portal's home page with a file to upload and its
// base label, ready to submit.
export async function fillUploadForm(page: Page, file: UploadedFile, label: RequestedLabel): Promise<void> {
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
  await page.getByLabel('DOCX or XLSX file, up to 20 MB').setInputFiles(file);
}

// Uploads a file through the form of the portal's home page, and gives the
// status of the portal's answer.
export async function upload(page: Page, file: UploadedFile, label: RequestedLabel): Promise<number> {
  await fillUploadForm(page, file, label);
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/documents/upload'));
  await page.getByRole('button', { name: 'Upload' }).click();
  return (await response).status();
}

// Uploads a file with a base label, by its code, as the form of the portal's
// home page sends it, but without opening the editor that the portal's
// answer leads to: no editing session saves the document afterwards. Gives
// the id of the document stored.
export async function uploadedDocumentId(page: Page, file: UploadedFile, base: string): Promise<string> {
  await page.goto('/');
  const url = await page.evaluate(
    async ({ name, mimeType, content, base }) => {
      const form = new FormData();
      form.append('base', base);
      form.append('file', new Blob([Uint8Array.from(atob(content), (character) => character.charCodeAt(0))], { type: mimeType }), name);
      const response = await fetch('/documents/upload', { method: 'POST', body: form, credentials: 'same-origin' });
      return response.url;
    },
    { name: file.name, mimeType: file.mimeType, content: file.buffer.toString('base64'), base },
  );
  const documentId = /\/documents\/([a-z0-9-]+)\/edit$/.exec(new URL(url).pathname)?.[1];
  if (documentId === undefined) {
    throw new Error(`The upload led to ${url} rather than to the editor`);
  }
  return documentId;
}

// A DOCX with one more Custom XML part of the main document, with its
// properties part, relationships and content type, as another labelling tool
// would write it, under the name Office gives such parts unless another is
// given.
export async function withCustomXmlPart(docx: Buffer, xml: string, namespace: string, name: string | null = null): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  let number = 1;
  while (zip.file(`customXml/item${number}.xml`) !== null) {
    number += 1;
  }
  const part = name ?? `customXml/item${number}.xml`;
  zip.file(part, xml);
  zip.file(
    `customXml/itemProps${number}.xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ds:datastoreItem ds:itemID="{${randomUUID().toUpperCase()}}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="${namespace}"/></ds:schemaRefs></ds:datastoreItem>`,
  );
  zip.file(
    `customXml/_rels/${part.slice('customXml/'.length)}.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps${number}.xml"/></Relationships>`,
  );
  const relationships = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  zip.file(
    'word/_rels/document.xml.rels',
    relationships.replace(
      '</Relationships>',
      `<Relationship Id="rIdTool${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../${part}"/></Relationships>`,
    ),
  );
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  zip.file(
    '[Content_Types].xml',
    types.replace('</Types>', `<Override PartName="/customXml/itemProps${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/></Types>`),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const LABEL_LIST_NAMESPACE = 'http://schemas.microsoft.com/office/2020/mipLabelMetadata';

// A tenant's sensitivity label properties, as [MS-OI29500] §3.11.2 shows Word
// writing them.
export function wordLabelProperties(labelId: string, tenant: string, firstPid: number): string {
  const values = [['Enabled', 'true'], ['SetDate', '2018-09-24T21:38:47-0800'], ['Method', 'Standard'], ['Name', 'Fictional label'], ['SiteId', tenant], ['ActionId', randomUUID()], ['ContentBits', '0']];
  return values
    .map(([attribute, value], index) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${firstPid + index}" name="MSIP_Label_${labelId}_${attribute}"><vt:lpwstr>${value}</vt:lpwstr></property>`)
    .join('');
}

// A Sensitivity Label Information element, as the examples of
// [MS-OFFCRYPTO] §3.12 write it, ids braced.
export function wordLabelElement(labelId: string, tenant: string): string {
  return `<clbl:label id="{${labelId}}" enabled="1" method="Standard" siteId="{${tenant}}" contentBits="0" removed="0" />`;
}

// A DOCX whose custom properties become the given ones, with a Sensitivity
// Label Information part, its relationship and its content type, as Word
// writes them in a tenant that turned co-authoring on.
export async function withLabelMetadata(docx: Buffer, metadata: { properties: string; labelList: string }): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  zip.file(
    'docProps/custom.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${metadata.properties}</Properties>`,
  );
  zip.file('docMetadata/LabelInfo.xml', `<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="${LABEL_LIST_NAMESPACE}">${metadata.labelList}</clbl:labelList>`);
  const relationships = (await zip.file('_rels/.rels')?.async('string')) ?? '';
  zip.file(
    '_rels/.rels',
    relationships.replace('</Relationships>', '<Relationship Id="rIdLabels" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/LabelInfo.xml"/></Relationships>'),
  );
  const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}
