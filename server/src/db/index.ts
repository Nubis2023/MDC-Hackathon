/**
 * SQLite connection and migration runner.
 *
 * Uses better-sqlite3, which is synchronous. That is a deliberate choice for
 * this service: a single connection serialises writes, which makes the
 * "commit the journal, allocation, balance changes and audit event in one
 * transaction" requirement straightforward to guarantee. The concurrency
 * tests exercise the interleaving that matters (two requests racing for the
 * same invoice), and better-sqlite3's immediate transactions plus the
 * optimistic version checks are what make that safe.
 *
 * NOTE ON POSTGRES: the production target is Supabase (Postgres), whose
 * driver is asynchronous, so this file's synchronous shape does not carry
 * over unchanged. The schema is already ported and verified in
 * `supabase/`; the service-layer port is scoped in `supabase/README.md`
 * under "Porting the service layer". It is a real refactor, not a driver
 * swap, which is why it is not half-applied here.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Db = Database.Database;

const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Candidate locations for schema.sql.
 *
 * The build copies it next to the compiled db module, but during `tsx`
 * development this file lives under src/. Trying both means `npm run dev`,
 * `npm start` and the test runner all work without a separate code path.
 */
const SCHEMA_CANDIDATES = [
  SCHEMA_PATH,
  join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
];

/**
 * Default database file, resolved relative to the server package root rather
 * than the process CWD so `npm run dev`, `npm start` and a direct
 * `node dist/index.js` all land on the same file.
 */
export const DEFAULT_DB_PATH = resolve(__dirname, '..', '..', 'data', 'ledger.db');

let schemaSql: string | null = null;

function loadSchema(): string {
  if (schemaSql === null) {
    const found = SCHEMA_CANDIDATES.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `could not locate schema.sql; looked in:\n  ${SCHEMA_CANDIDATES.join('\n  ')}`,
      );
    }
    schemaSql = readFileSync(found, 'utf8');
  }
  return schemaSql;
}

export interface OpenDbOptions {
  /** ':memory:' for tests, or a file path for the running app. */
  filename: string;
  /** Set false when the caller manages its own schema application. */
  migrate?: boolean;
}

export function openDb(options: OpenDbOptions): Db {
  const db = new Database(options.filename);
  // WAL is what lets the HTTP server read while a posting transaction is
  // still committing, without readers blocking on the writer.
  if (options.filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  // Wait rather than fail when another connection holds the write lock.
  db.pragma('busy_timeout = 5000');
  if (options.migrate !== false) {
    applySchema(db);
  }
  return db;
}

export function applySchema(db: Db): void {
  db.exec(loadSchema());
}

/** Fresh in-memory database for a single test case. */
export function createTestDb(): Db {
  return openDb({ filename: ':memory:' });
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}

/**
 * Run `fn` in an IMMEDIATE transaction. IMMEDIATE takes the write lock at
 * BEGIN rather than at first write, so two concurrent postings cannot both
 * read a stale balance and then race to write it.
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run.immediate();
}

/** Ensure the directory holding the database file exists. */
export function ensureDbDirectory(file: string): void {
  if (file === ':memory:') return;
  const dir = dirname(file);
  if (!existsSync(dir)) {
    require('node:fs').mkdirSync(dir, { recursive: true });
  }
}
