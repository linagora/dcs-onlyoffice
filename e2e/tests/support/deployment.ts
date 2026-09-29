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

// The stack's public domain: that of the stack under test, else the
// standalone profile's default.
export const DOMAIN: string = settingOf('DOMAIN') ?? 'dcs.localhost';

// Whether browsers resolve the stack's host names to this machine by
// themselves, as they resolve every name under localhost.
const RESOLVED_BY_BROWSERS: boolean = DOMAIN === 'localhost' || DOMAIN.endsWith('.localhost');

// The settings that lead Chromium and Firefox to the local reverse proxy
// under a domain other than localhost, where no hosts-file change is then
// needed; none under localhost, which the browsers resolve by themselves.
export const CHROMIUM_RESOLVER_ARGS: string[] = RESOLVED_BY_BROWSERS ? [] : [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`];
export const FIREFOX_RESOLVER_PREFS: Record<string, string> = RESOLVED_BY_BROWSERS
  ? {}
  : { 'network.dns.localDomains': ['portail', 'docs', 'idp', 'tdf'].map((host) => `${host}.${DOMAIN}`).join(',') };

// A setting of the stack under test, which must be set.
export function deploymentSetting(name: string): string {
  const value = settingOf(name);
  if (value === null) {
    throw new Error(`${name} is set neither in the environment nor in deploy/.env`);
  }
  return value;
}

// A setting of the stack under test: the environment's, which wins over the
// .env file that compose reads; null when neither sets it.
function settingOf(name: string): string | null {
  return process.env[name] || settingInFile(name);
}

// A setting of deploy/.env, null when the file or the setting is missing.
function settingInFile(name: string): string | null {
  try {
    return parseEnv(readFileSync(SETTINGS_FILE, 'utf8'))[name] || null;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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

// Stores a file, a DOCX unless told otherwise, as the portal's document
// `documentId`, bypassing the portal, as someone with access to its storage
// could.
export async function storeDocument(documentId: string, content: Uint8Array, extension: '.docx' | '.xlsx' = '.docx'): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stored-document-'));
  try {
    const file = path.join(directory, `${documentId}${extension}`);
    await writeFile(file, content);
    compose('cp', file, `portal:/data/documents/${documentId}${extension}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Fails with docker's own message.
function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...args], { cwd: COMPOSE_DIRECTORY, stdio: 'pipe', encoding: 'utf8' });
}
