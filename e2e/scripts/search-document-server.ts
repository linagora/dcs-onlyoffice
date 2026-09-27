import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CANARY_MARKER, PORTION_MARKER } from '../tests/support/marker.ts';
import { tracesIn } from '../tests/support/traces.ts';

// Run after the end-to-end suite: every portion text it wrote carries the
// portion marker, so finding it, in any form, among the Document Server's
// working files means that a portion text reached ONLYOFFICE. The server
// runs no database: it keeps co-editing changes in memory and writes them,
// with the saved file, in zip archives, which the search opens. The texts of
// unencrypted portions carry the canary instead, which the search must find:
// otherwise it cannot see what it looks for.

const FOLDERS = ['/var/lib/onlyoffice', '/var/www/onlyoffice/Data', '/var/log/onlyoffice', '/tmp'];
const COMPOSE_DIRECTORY = new URL('../../deploy/', import.meta.url);
// The Document Server saves a document 5 s after its last editor leaves.
const SAVE_DELAY_MS = 15_000;

async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

await delay(SAVE_DELAY_MS);
const workspace = await mkdtemp(path.join(tmpdir(), 'dcs-document-server-'));
try {
  const leaks: string[] = [];
  const canaries: string[] = [];
  for (const folder of FOLDERS) {
    const copy = path.join(workspace, folder.slice(1).replaceAll('/', '_'));
    execFileSync('docker', ['compose', 'cp', `onlyoffice:${folder}`, copy], { cwd: COMPOSE_DIRECTORY, stdio: 'ignore' });
    for (const file of await filesUnder(copy)) {
      const name = path.join(folder, path.relative(copy, file));
      const content = await readFile(file);
      leaks.push(...(await tracesIn(content, name, [PORTION_MARKER])));
      canaries.push(...(await tracesIn(content, name, [CANARY_MARKER])));
    }
  }
  if (leaks.length > 0) {
    process.stderr.write(`Portion texts reached the Document Server:\n${leaks.join('\n')}\n`);
    process.exitCode = 1;
  } else if (canaries.length === 0) {
    process.stderr.write('No canary among the working files: run the end-to-end suite first, or the search cannot see what it looks for.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`No trace of a portion text among ${FOLDERS.join(', ')}, where ${canaries.length} canaries were found.\n`);
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
