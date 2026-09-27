import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecurityPolicy } from '../spif/model.ts';
import { type Clearance, type ClearanceRequest, checkClearance } from './clearance.ts';
import type { ClearanceStore } from './store.ts';

// The clearance directory, and the folder of JSON files that seed it.
export interface ClearanceDirectoryOptions {
  store: ClearanceStore;
  seedFolder: string | null;
}

export interface SeedOutcome {
  seeded: number;
  added: number;
}

// Readies the store and adds the seed's clearances it does not hold yet. A
// single invalid entry stops the service, as a broken SPIF does.
export async function prepareClearanceDirectory(options: ClearanceDirectoryOptions, policies: SecurityPolicy[]): Promise<SeedOutcome> {
  await options.store.prepare();
  const seed = options.seedFolder === null ? [] : await readSeedClearances(options.seedFolder, policies);
  return { seeded: seed.length, added: await options.store.addMissing(seed) };
}

// Every JSON file of the folder holds {"clearances": [...]}.
async function readSeedClearances(folder: string, policies: SecurityPolicy[]): Promise<Clearance[]> {
  const files = (await readdir(folder)).filter((file) => file.endsWith('.json')).sort();
  const clearances: Clearance[] = [];
  for (const file of files) {
    const source = path.join(folder, file);
    const document: unknown = JSON.parse(await readFile(source, 'utf8'));
    for (const request of seedRequests(document, source)) {
      const check = checkClearance(request, policies);
      if (!check.ok) {
        throw new Error(`${source}: ${check.error}`);
      }
      clearances.push(check.clearance);
    }
  }
  return clearances;
}

function seedRequests(document: unknown, source: string): ClearanceRequest[] {
  if (typeof document !== 'object' || document === null || !('clearances' in document) || !Array.isArray(document.clearances)) {
    throw new Error(`${source} holds no "clearances" list`);
  }
  const entries: unknown[] = document.clearances;
  return entries.map((entry, index) => {
    const request = seedRequest(entry);
    if (request === null) {
      throw new Error(`${source}: clearance ${index + 1} is incomplete`);
    }
    return request;
  });
}

// A seed entry gives its validity period as ISO 8601 dates.
function seedRequest(entry: unknown): ClearanceRequest | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const field = (name: string): unknown => (name in entry ? (entry as Record<string, unknown>)[name] : null); // SAFETY: object checked above
  const email = field('email');
  const name = field('name');
  const nationality = field('nationality');
  const policy = field('policy');
  const classification = field('classification');
  const categories = field('categories');
  const validFrom = dateOf(field('validFrom'));
  const validUntil = dateOf(field('validUntil'));
  if (
    typeof email !== 'string' ||
    typeof name !== 'string' ||
    (nationality !== null && typeof nationality !== 'string') ||
    typeof policy !== 'string' ||
    typeof classification !== 'string' ||
    !Array.isArray(categories) ||
    !categories.every((category: unknown): category is string => typeof category === 'string') ||
    validFrom === null ||
    validUntil === null
  ) {
    return null;
  }
  return { email, name, nationality, policy, classification, categories, validFrom, validUntil };
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
