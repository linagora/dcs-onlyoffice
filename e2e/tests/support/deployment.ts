import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

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
// an outage would, while `during` runs: the one place where a test reaches
// past the browser and the APIs. The policy service grants the reader role
// its columns again when it restarts; a run interrupted meanwhile leaves the
// directory unreadable until it does.
export async function withUnreadableDirectory(during: () => Promise<void>): Promise<void> {
  compose('exec', '-T', 'postgres', 'psql', '-U', 'opentdf', '-d', 'opentdf', '-q', '-c', 'REVOKE SELECT ON directory.clearances FROM dcs_directory_reader');
  try {
    await during();
  } finally {
    compose('restart', 'policy');
    compose('up', '-d', '--wait', '--no-deps', '--no-recreate', 'policy');
  }
}

// Fails with docker's own message.
function compose(...args: string[]): void {
  execFileSync('docker', ['compose', ...args], { cwd: COMPOSE_DIRECTORY, stdio: 'pipe' });
}
