import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { deploymentSetting } from '../tests/support/deployment.ts';

// Run against the running stack: the portal's internal route, which serves
// stored documents to the Document Server, must answer only a Document
// Server download token for that very document, and neither an editor
// configuration, which every browser receives, nor another document's token.
// The route is out of a browser's reach, so the requests run inside the
// portal's container.

const COMPOSE_DIRECTORY = new URL('../../deploy/', import.meta.url);
// A demo document that every stack holds.
const DOCUMENT = 'exercise-northwind';

const contentUrl = (id: string): string => `http://portal:3000/internal/documents/${id}/content`;

function signed(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ...claims, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signature = createHmac('sha256', deploymentSetting('ONLYOFFICE_JWT_SECRET')).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function downloadStatus(token: string): number {
  const output = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'portal',
      'node',
      '-e',
      "fetch(process.argv[1], { headers: { Authorization: `Bearer ${process.argv[2]}` } }).then((response) => console.log(response.status))",
      contentUrl(DOCUMENT).replace('portal:3000', '127.0.0.1:3000'),
      token,
    ],
    { cwd: COMPOSE_DIRECTORY, encoding: 'utf8' },
  );
  return Number(output.trim());
}

const expectations: { name: string; claims: Record<string, unknown>; status: number }[] = [
  { name: 'a download token for the document', claims: { payload: { url: contentUrl(DOCUMENT) } }, status: 200 },
  { name: "another document's download token", claims: { payload: { url: contentUrl('another-document') } }, status: 401 },
  { name: 'an editor configuration', claims: { document: { url: contentUrl(DOCUMENT), key: 'any' } }, status: 401 },
];
let failed = false;
for (const { name, claims, status } of expectations) {
  const answered = downloadStatus(signed(claims));
  console.log(`${name}: ${answered}${answered === status ? '' : `, expected ${status}`}`);
  failed ||= answered !== status;
}
process.exitCode = failed ? 1 : 0;
