import pg from 'pg';
import { type Clearance, categoryText, type HeldCategory, heldCategoryOf } from './clearance.ts';
import { fieldOf } from './record.ts';

// Where the clearance directory keeps its entries.
export interface ClearanceStore {
  // Creates what the store needs, when it is missing.
  prepare(): Promise<void>;
  // Adds the clearances the store does not hold yet. An entry that exists,
  // possibly changed since by an administrator, stays as it is.
  addMissing(clearances: Clearance[]): Promise<number>;
  // The entry of one person, by lower-case email address, under one policy,
  // whatever its validity period.
  clearanceOf(email: string, policy: string): Promise<Clearance | null>;
  close(): Promise<void>;
}

export interface DatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// The stack's setup job creates the schema, owned by the policy service, and
// this role, which OpenTDF's entity resolution logs in with.
const READER_ROLE = 'dcs_directory_reader';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS directory.clearances (
  email text NOT NULL,
  policy text NOT NULL,
  name text NOT NULL,
  nationality text,
  classification text NOT NULL,
  categories text[] NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY (email, policy)
)`;

// OpenTDF only reads the columns an access decision needs, never a person's
// name or nationality. Granting on every start also repairs a changed grant.
const GRANT_READER = `
REVOKE ALL ON directory.clearances FROM ${READER_ROLE};
GRANT SELECT (email, policy, classification, categories, valid_from, valid_until) ON directory.clearances TO ${READER_ROLE}`;

const SELECT_ONE = `
SELECT email, policy, name, nationality, classification, categories, valid_from, valid_until
FROM directory.clearances
WHERE email = $1 AND policy = $2`;

const INSERT_MISSING = `
INSERT INTO directory.clearances (email, policy, name, nationality, classification, categories, valid_from, valid_until)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (email, policy) DO NOTHING`;

export class PostgresClearanceStore implements ClearanceStore {
  #pool: pg.Pool;

  constructor(settings: DatabaseSettings) {
    this.#pool = new pg.Pool(settings);
  }

  async prepare(): Promise<void> {
    await this.#pool.query(CREATE_TABLE);
    await this.#pool.query(GRANT_READER);
  }

  async addMissing(clearances: Clearance[]): Promise<number> {
    let added = 0;
    for (const clearance of clearances) {
      const result = await this.#pool.query(INSERT_MISSING, [
        clearance.email,
        clearance.policy,
        clearance.name,
        clearance.nationality,
        clearance.classification,
        clearance.categories.map(categoryText),
        clearance.validFrom,
        clearance.validUntil,
      ]);
      added += result.rowCount ?? 0;
    }
    return added;
  }

  async clearanceOf(email: string, policy: string): Promise<Clearance | null> {
    const result = await this.#pool.query(SELECT_ONE, [email, policy]);
    const row: unknown = result.rows[0];
    return row === undefined ? null : clearanceOfRow(row);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

// The driver gives timestamps as dates and arrays as arrays; anything else
// means the table is not the one the service created.
function clearanceOfRow(row: unknown): Clearance {
  const column = (name: string): unknown => fieldOf(row, name);
  const text = (name: string): string => {
    const value = column(name);
    if (typeof value !== 'string') {
      throw new Error(`directory.clearances has no text in ${name}`);
    }
    return value;
  };
  const date = (name: string): Date => {
    const value = column(name);
    if (!(value instanceof Date)) {
      throw new Error(`directory.clearances has no timestamp in ${name}`);
    }
    return value;
  };
  const categoryTexts = column('categories');
  const categories = Array.isArray(categoryTexts)
    ? categoryTexts.map((category: unknown) => (typeof category === 'string' ? heldCategoryOf(category) : null))
    : null;
  if (categories === null || categories.some((category) => category === null)) {
    throw new Error('directory.clearances holds categories it cannot read');
  }
  const nationality = column('nationality');
  return {
    email: text('email'),
    name: text('name'),
    nationality: typeof nationality === 'string' ? nationality : null,
    policy: text('policy'),
    classification: text('classification'),
    categories: categories.filter((category): category is HeldCategory => category !== null),
    validFrom: date('valid_from'),
    validUntil: date('valid_until'),
  };
}
