/**
 * Database wiring: which backend, and applying the schema.
 *
 * Chosen by connection string, not by NODE_ENV, so a local Postgres or a
 * Supabase branch both work without a code change:
 *
 *   SUPABASE_DB_URL set  -> Postgres (Supabase)
 *   otherwise            -> SQLite at DB_FILE (tests, local development)
 *
 * Tests get in-memory SQLite via createTestDb(), so the suite runs with no
 * external services. The same suite runs against Postgres by setting
 * SUPABASE_DB_URL, which is how the port is validated.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SqlDb } from './sql-db';
import { SqliteDb } from './sqlite-db';
import { openPostgres } from './postgres-db';

export type { SqlDb, RunResult } from './sql-db';
export { SqliteDb } from './sqlite-db';
export { PostgresDb, openPostgres, toPgPlaceholders } from './postgres-db';

const SQLITE_SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Candidate locations for the SQLite schema. The build copies it next to the
 * compiled module; during `tsx` development it lives under src/.
 */
const SQLITE_SCHEMA_CANDIDATES = [
  SQLITE_SCHEMA_PATH,
  join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
];

/**
 * The Postgres schema IS the Supabase migration, so the two cannot drift.
 * Applying it here is what lets an empty Postgres database be brought up by
 * the same code path that creates a SQLite one.
 */
const POSTGRES_SCHEMA_CANDIDATES = [
  join(__dirname, '..', '..', 'supabase', 'migrations', '20260919000000_seller_ledger.sql'),
  join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260919000000_seller_ledger.sql'),
];

/** Default SQLite file, relative to the server package root rather than CWD. */
export const DEFAULT_DB_PATH = resolve(__dirname, '..', '..', 'data', 'ledger.db');

function readFirst(paths: string[], label: string): string {
  const found = paths.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `could not locate the ${label} schema; looked in:\n  ${paths.join('\n  ')}`,
    );
  }
  return readFileSync(found, 'utf8');
}

/** The SQLite schema, used to create and migrate a local database. */
export function loadSqliteSchema(): string {
  return readFirst(SQLITE_SCHEMA_CANDIDATES, 'SQLite');
}

/** The Postgres/Supabase schema. */
export function loadPostgresSchema(): string {
  return readFirst(POSTGRES_SCHEMA_CANDIDATES, 'Postgres');
}

export interface OpenDbOptions {
  /** ':memory:' for tests, or a file path for local development. */
  filename: string;
  /** Apply the bundled schema on open. */
  migrate?: boolean;
}

/**
 * Open a SQLite database. Synchronous on purpose: better-sqlite3 is, and tests
 * needing a handle immediately should not have to await.
 */
export function openDb(options: OpenDbOptions): SqliteDb {
  if (options.filename !== ':memory:') {
    const dir = dirname(options.filename);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new SqliteDb({ filename: options.filename });
  if (options.migrate !== false) {
    db.handle.exec(loadSqliteSchema());
  }
  return db;
}

/** Fresh in-memory database for a single test case. */
export function createTestDb(): SqliteDb {
  return openDb({ filename: ':memory:' });
}

/**
 * Apply the active backend's schema to an open database.
 *
 * On Postgres this is a no-op when the schema is already present — which it is
 * on Supabase, and on the local verification harness — because the migration is
 * written to be idempotent. `force` re-applies it, and `authStub` creates the
 * `auth` schema and `auth.uid()` that Supabase provides but bare Postgres does
 * not.
 */
export async function applySchema(
  db: SqlDb,
  options: { authStub?: boolean; force?: boolean } = {},
): Promise<void> {
  if (db.dialect === 'sqlite') {
    await db.exec(loadSqliteSchema());
    return;
  }

  if (options.authStub) {
    await db.exec(`
      create schema if not exists auth;
      create table if not exists auth.users (
        id uuid primary key default gen_random_uuid(),
        email text
      );
      create or replace function auth.uid()
      returns uuid language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    `);
  }

  if (options.force) {
    await db.exec(loadPostgresSchema());
    return;
  }

  const existing = await db.get<{ n: number }>(
    `select count(*)::int as n from pg_tables
      where schemaname = 'public' and tablename = 'journal_entries'`,
  );
  if (!existing || existing.n === 0) {
    await db.exec(loadPostgresSchema());
  }
}

/**
 * Choose a backend from the environment.
 */
export function openDatabaseFromEnv(): SqlDb {
  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    const sslMode = (process.env.SUPABASE_DB_SSL ?? 'require') as
      | 'require'
      | 'no-verify'
      | 'disable';
    // Pool size is configurable because some Postgres-compatible servers
    // (PGlite's socket implementation among them) do not isolate session state
    // across concurrent connections, and a pool of 1 is the only way to talk
    // to them. Real Postgres — including Supabase — is fine with the default.
    const max = Number(process.env.SUPABASE_DB_POOL_MAX ?? 10);
    return openPostgres({ url, ssl: sslMode, max: Number.isFinite(max) ? max : 10 });
  }
  const file = process.env.DB_FILE ?? DEFAULT_DB_PATH;
  return openDb({ filename: file });
}

/** Human-readable description of the active backend, with any password masked. */
export function describeDatabase(db: SqlDb): string {
  if (db.dialect === 'postgres') {
    const masked = (process.env.SUPABASE_DB_URL ?? '').replace(/:[^:@/]*@/, ':***@');
    return `postgres ${masked}`;
  }
  return `sqlite ${process.env.DB_FILE ?? DEFAULT_DB_PATH}`;
}

/** Ensure the directory holding a SQLite file exists. No-op for Postgres. */
export function ensureDbDirectory(file: string): void {
  if (file === ':memory:') return;
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
