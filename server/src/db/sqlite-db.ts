/**
 * SQLite implementation of SqlDb, wrapping better-sqlite3.
 *
 * The driver is synchronous but this class is async, so the service layer can
 * be written once. That mismatch creates one real hazard, handled here:
 *
 *   Interleaving. If two transactions both `await` inside their callback their
 *   statements can interleave — A reads a balance, yields, B reads the same
 *   balance, both write. On SQLite that is worse than a lost update:
 *   `BEGIN IMMEDIATE` takes the write lock at BEGIN, so B's BEGIN blocks with
 *   SQLITE_BUSY, and because the driver is synchronous that busy-wait blocks
 *   the event loop, so A can never resume to release the lock. A deadlock,
 *   not an error.
 *
 * The fix is to serialise transactions: one runs at a time and the rest queue
 * on a promise chain. Since better-sqlite3 executes each statement
 * synchronously, a queued transaction's awaits all resolve before the next one
 * is admitted, so its read-then-write window is never observed by anyone else.
 * That restores the isolation the old fully-synchronous code got for free.
 */

import Database from 'better-sqlite3';
import type { RunResult, SqlDb } from './sql-db';

export interface SqliteDbOptions {
  filename: string;
}

export class SqliteDb implements SqlDb {
  readonly dialect = 'sqlite' as const;

  private readonly raw: Database.Database;
  /** Tail of the transaction queue; transactions chain onto it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Depth counter, so a nested transaction joins the enclosing one. */
  private depth = 0;

  constructor(options: SqliteDbOptions) {
    this.raw = new Database(options.filename);
    if (options.filename !== ':memory:') {
      this.raw.pragma('journal_mode = WAL');
    }
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
  }

  /**
   * The raw better-sqlite3 handle.
   *
   * Exposed only for schema application at startup and for tests that need to
   * simulate out-of-band corruption (a tampered cached balance). Service code
   * must not use it — that would bypass the transaction serialisation above
   * and reintroduce the deadlock it exists to prevent.
   */
  get handle(): Database.Database {
    return this.raw;
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params as unknown[])) as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const row = this.raw.prepare(sql).get(...(params as unknown[]));
    return (row as T | undefined) ?? null;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const info = this.raw.prepare(sql).run(...(params as unknown[]));
    return { changes: info.changes };
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    // A nested call joins the enclosing transaction: SQLite has no nested
    // BEGIN, and the service layer legitimately composes transactions (a
    // posting calls helpers that each want atomicity).
    if (this.depth > 0) {
      this.depth++;
      try {
        return await fn(this);
      } finally {
        this.depth--;
      }
    }

    const run = this.queue.then(async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const result = await fn(this);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          // A failed rollback must not mask the original error, which is the
          // one that explains what actually went wrong.
        }
        throw err;
      } finally {
        this.depth--;
      }
    });

    // Keep the chain alive after a failure, or one rolled-back transaction
    // would wedge every later one.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}
