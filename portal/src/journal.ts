import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import type { UserIdentity } from './auth/sessions.ts';

// What an entry records, as administrators filter the journal.
export const JOURNAL_CATEGORIES = ['label', 'upload', 'save', 'clearance', 'session', 'stored-file'] as const;
export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number];

// What a person was to an entry: who acted, who took part in an editing
// session, who was excluded from one, who downloaded a file, whose clearance
// changed.
const JOURNAL_ROLES = ['author', 'session', 'excluded', 'downloader', 'holder'] as const;
export type JournalRole = (typeof JOURNAL_ROLES)[number];

// A person an entry names, as the portal knew them when it recorded it. The
// name and the email address are null for someone the portal knows by their
// identifier only.
export interface JournalPerson {
  role: JournalRole;
  id: string;
  name: string | null;
  email: string | null;
}

// An entry as the portal records it: the line it writes to its log, with its
// level, message and fields, which keep the form they had before the journal
// was stored, and the document and the people it concerns.
export interface JournalEntry {
  category: JournalCategory;
  level: 'info' | 'warn';
  message: string;
  documentId: string | null;
  fields: Record<string, unknown>;
  people: JournalPerson[];
}

// An entry as the journal keeps it.
export interface StoredJournalEntry {
  id: string;
  recordedAt: Date;
  category: JournalCategory;
  message: string;
  documentId: string | null;
  people: JournalPerson[];
  fields: Record<string, unknown>;
}

// Which entries a page of the journal shows: null leaves a filter out.
// `before` is the identifier of the last entry of the newer page.
export interface JournalFilters {
  document: string | null;
  person: string | null;
  from: Date | null;
  until: Date | null;
  category: JournalCategory | null;
  before: string | null;
}

// A page of entries, newest first, and the identifier to give as `before` for
// the older ones; null when there are none.
export interface JournalPage {
  entries: StoredJournalEntry[];
  older: string | null;
}

export interface JournalDatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// The role may add these columns only: the database gives an entry its
// identifier and its time.
const INSERT = `
INSERT INTO journal.entries (category, message, document_id, people, fields)
VALUES ($1, $2, $3, $4, $5)`;

const SELECT_PAGE = `
SELECT id, recorded_at, category, message, document_id, people, fields
FROM journal.entries
WHERE ($1::text IS NULL OR document_id = $1)
  AND ($2::text IS NULL OR EXISTS (
    SELECT FROM jsonb_array_elements(people) AS person WHERE person->>'name' ILIKE $2 OR person->>'email' ILIKE $2))
  AND ($3::timestamptz IS NULL OR recorded_at >= $3)
  AND ($4::timestamptz IS NULL OR recorded_at < $4)
  AND ($5::text IS NULL OR category = $5)
  AND ($6::bigint IS NULL OR id < $6)
ORDER BY id DESC
LIMIT $7`;

// The journal: every entry goes to the portal's log, as it always did, with
// the people it names, and to the stack's database, where the portal's role
// may only add entries and read them (ADR 0007). An entry the database
// refuses is logged again, whole, with the failure: the action that caused
// it goes on.
export class Journal {
  #pool: pg.Pool;
  #log: FastifyBaseLogger;

  constructor(database: JournalDatabaseSettings, log: FastifyBaseLogger) {
    this.#pool = new pg.Pool(database);
    // An idle connection the database drops is replaced at the next query.
    this.#pool.on('error', (error) => {
      log.error({ err: error }, 'A connection to the journal failed');
    });
    this.#log = log;
  }

  record(entry: JournalEntry): void {
    const line = { ...(entry.documentId === null ? {} : { documentId: entry.documentId }), ...entry.fields, people: entry.people };
    if (entry.level === 'warn') {
      this.#log.warn(line, entry.message);
    } else {
      this.#log.info(line, entry.message);
    }
    this.#pool
      .query(INSERT, [entry.category, entry.message, entry.documentId, JSON.stringify(entry.people), JSON.stringify(entry.fields)])
      .catch((error: unknown) => {
        this.#log.error({ err: error, entry }, 'The journal could not store an entry');
      });
  }

  async page(filters: JournalFilters, size: number): Promise<JournalPage> {
    const person = filters.person === null ? null : `%${filters.person.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const result = await this.#pool.query(SELECT_PAGE, [
      filters.document,
      person,
      filters.from,
      filters.until,
      filters.category,
      filters.before,
      size + 1,
    ]);
    const rows: unknown[] = result.rows;
    const entries = rows.slice(0, size).map(storedEntryOf);
    return { entries, older: rows.length > size ? (entries.at(-1)?.id ?? null) : null };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

// A person an entry names, whom the portal knows.
export function journalPerson(role: JournalRole, user: UserIdentity): JournalPerson {
  return { role, id: user.id, name: user.name, email: user.email };
}

// A person an entry names by their identifier, with what the portal knows of
// them, if anything.
export function journalPersonById(role: JournalRole, id: string, user: UserIdentity | null): JournalPerson {
  return user === null ? { role, id, name: null, email: null } : journalPerson(role, user);
}

export function isJournalCategory(value: unknown): value is JournalCategory {
  const categories: readonly unknown[] = JOURNAL_CATEGORIES;
  return categories.includes(value);
}

function isJournalRole(value: unknown): value is JournalRole {
  const roles: readonly unknown[] = JOURNAL_ROLES;
  return roles.includes(value);
}

function storedEntryOf(row: unknown): StoredJournalEntry {
  if (typeof row !== 'object' || row === null) {
    throw new Error('Unexpected journal entry');
  }
  const { id, recorded_at: recordedAt, category, message, document_id: documentId, people, fields } = row as Record<string, unknown>; // SAFETY: object checked above
  if (
    typeof id !== 'string' ||
    !(recordedAt instanceof Date) ||
    !isJournalCategory(category) ||
    typeof message !== 'string' ||
    (documentId !== null && typeof documentId !== 'string') ||
    !Array.isArray(people) ||
    !people.every(isJournalPerson) ||
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields)
  ) {
    throw new Error('Unexpected journal entry');
  }
  return { id, recordedAt, category, message, documentId, people, fields: fields as Record<string, unknown> }; // SAFETY: a non-array object, checked above
}

function isJournalPerson(value: unknown): value is JournalPerson {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const person = value as Record<string, unknown>; // SAFETY: object checked above
  return (
    isJournalRole(person.role) &&
    typeof person.id === 'string' &&
    (person.name === null || typeof person.name === 'string') &&
    (person.email === null || typeof person.email === 'string')
  );
}
