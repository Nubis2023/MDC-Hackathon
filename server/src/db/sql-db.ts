/**
 * The database interface the service layer is written against.
 *
 * better-sqlite3 is synchronous; Postgres is not, and Node has no synchronous
 * Postgres driver. So supporting both is not a driver swap — the service layer
 * becomes async and talks to this interface, so that happens once rather than
 * once per backend:
 *
 *   SqliteDb    — better-sqlite3, in-process. Tests and local development.
 *   PostgresDb  — postgres-js over the wire. Supabase.
 *
 * Both accept the same SQL, written with `?` placeholders. SQLite takes those
 * natively; the Postgres implementation rewrites them to `$n`. One placeholder
 * convention means the service SQL is written once.
 */

export interface RunResult {
  /** Rows affected by an INSERT/UPDATE/DELETE. */
  changes: number;
}

export interface SqlDb {
  /** All matching rows. */
  all<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** The first matching row, or null. */
  get<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** Execute a statement that returns no rows. */
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  /** Execute raw SQL with no parameters (DDL, pragmas, multi-statement files). */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   *
   * The callback receives a handle bound to the transaction. That distinction
   * is load-bearing on Postgres: a statement issued on the pool instead of the
   * transaction connection commits independently, which is precisely the
   * atomicity bug the transaction tests exist to catch. Every write inside a
   * posting must go through `tx`.
   */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;

  /** Which implementation is in use, for diagnostics and branching. */
  readonly dialect: 'sqlite' | 'postgres';

  close(): Promise<void>;
}
