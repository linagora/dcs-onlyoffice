import pg from 'pg';
import { type Clearance, categoryText } from './clearance.ts';

// Where the clearance directory keeps its entries.
export interface ClearanceStore {
  // Creates what the store needs, when it is missing.
  prepare(): Promise<void>;
  // Adds the clearances the store does not hold yet. An entry that exists,
  // possibly changed since by an administrator, stays as it is.
  addMissing(clearances: Clearance[]): Promise<number>;
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

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
