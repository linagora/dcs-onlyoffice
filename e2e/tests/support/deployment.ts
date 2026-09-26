import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const SETTINGS_FILE = new URL('../../../deploy/.env', import.meta.url);

// A setting of the stack under test: the environment wins over the .env file
// that compose reads.
export function deploymentSetting(name: string): string {
  const value = process.env[name] ?? parseEnv(readFileSync(SETTINGS_FILE, 'utf8'))[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is set neither in the environment nor in deploy/.env`);
  }
  return value;
}
