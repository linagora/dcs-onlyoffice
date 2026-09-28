import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { field } from './json.ts';

const COMPOSE_DIRECTORY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const SETTINGS_FILE = new URL('../../../deploy/.env', import.meta.url);

// The stack's public domain, as the Playwright configuration reads it.
export const DOMAIN = process.env.DOMAIN ?? 'dcs.test';

// A setting of the stack under test: the environment wins over the .env file
// that compose reads.
export function deploymentSetting(name: string): string {
  const value = process.env[name] ?? parseEnv(readFileSync(SETTINGS_FILE, 'utf8'))[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is set neither in the environment nor in deploy/.env`);
  }
  return value;
}

// Makes the clearance directory unreadable to OpenTDF's entity resolution, as
// an outage would, while `during` runs: with the portal's log and its storage,
// the places where a test reaches past the browser and the APIs. The policy
// service grants the reader role its columns again when it restarts; a run
// interrupted meanwhile leaves the directory unreadable until it does.
export async function withUnreadableDirectory(during: () => Promise<void>): Promise<void> {
  compose('exec', '-T', 'postgres', 'psql', '-U', 'opentdf', '-d', 'opentdf', '-q', '-c', 'REVOKE SELECT ON directory.clearances FROM dcs_directory_reader');
  try {
    await during();
  } finally {
    compose('restart', 'policy');
    compose('up', '-d', '--wait', '--no-deps', '--no-recreate', 'policy');
  }
}

// The portal's log since `since`, as it writes it: one JSON object a line.
export function portalLog(since: Date): string {
  return compose('logs', '--no-log-prefix', '--since', since.toISOString(), 'portal');
}

// The entries of the portal's log since `since`.
export function portalLogEntries(since: Date): unknown[] {
  return portalLog(since)
    .split('\n')
    .flatMap((line) => {
      try {
        const entry: unknown = JSON.parse(line);
        return [entry];
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          return [];
        }
        throw error;
      }
    });
}

// The entries of the portal's journal about a portion since `since`, with
// the given message.
export function portionJournal(since: Date, message: string, portionId: string): unknown[] {
  return portalLogEntries(since).filter((entry) => field(entry, 'msg') === message && field(entry, 'portion') === portionId);
}

// The entries of the portal's log about a document since `since`, with the
// given message.
export function documentLogEntries(since: Date, message: string, documentId: string): unknown[] {
  return portalLogEntries(since).filter((entry) => field(entry, 'msg') === message && field(entry, 'documentId') === documentId);
}

// Stores a file as the portal's document `documentId`, bypassing the portal,
// as someone with access to its storage could.
export async function storeDocument(documentId: string, docx: Uint8Array): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stored-document-'));
  try {
    const file = path.join(directory, `${documentId}.docx`);
    await writeFile(file, docx);
    compose('cp', file, `portal:/data/documents/${documentId}.docx`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Fails with docker's own message.
function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...args], { cwd: COMPOSE_DIRECTORY, stdio: 'pipe', encoding: 'utf8' });
}
