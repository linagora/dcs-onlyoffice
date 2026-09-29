import type { Page } from '@playwright/test';

export interface UploadedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

// The base label an upload asks for: a label the form offers, by marking; or,
// as someone altering the page could, a code the form does not offer.
export type RequestedLabel = { marking: string } | { code: string };

// Uploads a file through the form of the portal's home page, and gives the
// status of the portal's answer.
export async function upload(page: Page, file: UploadedFile, label: RequestedLabel): Promise<number> {
  await page.goto('/');
  const labels = page.getByLabel('Base label');
  if ('code' in label) {
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
