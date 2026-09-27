import { test as base, type Page, type TestInfo } from '@playwright/test';
import { DEMO_ACCOUNTS, type DemoAccount, signIn } from './accounts.ts';
import { browserFetch, CREATED_DOCUMENT, watchEditorLoads } from './documents.ts';

export { expect } from '@playwright/test';

interface SignedInFixtures {
  account: DemoAccount;
}

// Every test starts signed in; a test can pick another account with
// test.use({ account: DEMO_ACCOUNTS.bob }).
export const test = base.extend<SignedInFixtures>({
  account: [DEMO_ACCOUNTS.alice, { option: true }],
  page: async ({ page, account, baseURL }, use, testInfo) => {
    watchEditorLoads(page);
    await signIn(page, account);
    await use(page);
    await attachCreatedDocuments(page, baseURL ?? null, testInfo);
  },
});

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Evidence for the stop report: the stored DOCX of every document the test
// created, as the portal serves it once the test is over. A test that left the
// portal (signed out, for instance) has none to attach.
async function attachCreatedDocuments(page: Page, portalUrl: string | null, testInfo: TestInfo): Promise<void> {
  if (portalUrl === null || page.isClosed() || !page.url().startsWith(portalUrl)) {
    return;
  }
  for (const annotation of testInfo.annotations.filter((candidate) => candidate.type === CREATED_DOCUMENT)) {
    const response = await browserFetch(page, `/documents/${annotation.description}/download`);
    if (response.status === 200) {
      await testInfo.attach(`${annotation.description}.docx`, { body: response.body, contentType: DOCX_TYPE });
    }
  }
}
