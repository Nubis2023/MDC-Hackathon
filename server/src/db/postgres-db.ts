/**
 * Postgres implementation of SqlDb, wrapping postgres-js. This is the
 * Supabase backend.
 *
 * Three things here are load-bearing and will silently corrupt data if wrong:
 *
 * 1. int8 parsing. Postgres `bigint` is returned as a *string* by postgres-js
 *    by default, to avoid precision loss past 2^53. Every money column in this
 *    schema is bigint, and so is every COUNT(*). Left alone, `balance_cents`
 *    arrives as "100000" and `a + b` concatenates instead of adding. The type
 *    parser below converts int8 to Number, which is safe because ledger cents
 *    stay far below 2^53.
 *
 * 2. Transaction binding. Statements inside a posting must be issued on the
 *    transaction's connection. Issuing them on the pool escapes the
 *    transaction and commits independently — the exact atomicity bug the
 *    transaction tests exist to catch. The handle passed to the callback is
 *    bound; the pool root is not.
 *
 * 3. Nested transactions. postgres-js refuses to `begin()` inside a
 *    transaction, and the service layer legitimately composes transactions, so
 *    a nested call joins the enclosing one instead of erroring.
 */

import postgres from 'postgres';
import type { RunResult, SqlDb } from './sql-db';

export interface PostgresDbOptions {
  url: string;
  /** Supabase requires TLS; a local server does not. */
  ssl?: 'require' | 'no-verify' | 'disable';
  max?: number;
}

/**
 * The slice of postgres-js this file uses.
 *
 * Declared structurally rather than reaching into the library's generic
 * `Sql<T>` type: those generics are parameterised by the custom type map, and
 * satisfying them here would mean either widening everything to `any` or
 * threading the map through every signature. A narrow structural type keeps
 * this strict and decouples the rest of the codebase from postgres-js.
 */
interface PendingQuery {
  simple(): Promise<unknown>;
}

/**
 * The one method every postgres-js connection offers, pool root or bound
 * transaction alike. PgConnection depends only on this, so a transaction
 * handle satisfies it without needing begin()/end().
 */
interface PgQueryable {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]> & PendingQuery;
}

/** A transaction handle. postgres-js nests via savepoint, hence begin(). */
interface PgTxHandle extends PgQueryable {
  begin<T>(fn: (tx: PgTxHandle) => Promise<T>): Promise<T>;
}

interface PgRoot extends PgQueryable {
  begin<T>(fn: (tx: PgTxHandle) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

/**
 * Rewrite `?` placeholders to Postgres `$1, $2, …`.
 *
 * Skips single-quoted strings, double-quoted identifiers and line comments, so
 * a literal `?` inside a string literal is left alone rather than becoming a
 * placeholder — which matters because several queries embed `jsonb` and memo
 * text, and a stray rewrite would shift every later parameter by one.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * A SqlDb over one postgres-js connection: either the pool root or a bound
 * transaction.
 *
 * The begin function is passed in rather than read off the handle, because a
 * bound transaction handle does not expose begin() as an optional member —
 * carrying it separately keeps the constructor's type exact and avoids a
 * possibly-undefined call.
 */
class PgConnection implements SqlDb {
  readonly dialect = 'postgres' as const;

  constructor(
    private readonly sql: PgQueryable,
    private readonly beginFn: ((fn: (tx: SqlDb) => Promise<unknown>) => Promise<unknown>) | null,
    private readonly inTransaction = false,
  ) {}

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(toPgPlaceholders(sql), params as unknown[]);
    return rows as unknown as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const result = (await this.sql.unsafe(
      toPgPlaceholders(sql),
      params as unknown[],
    )) as unknown as { count?: number };
    return { changes: Number(result.count ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    // Simple-query mode runs a multi-statement file as one call, which is how
    // the schema is applied.
    await this.sql.unsafe(sql).simple();
  }

  async transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    // Already inside a transaction: postgres-js cannot nest begin(), and the
    // caller wants the same atomicity anyway, so join the enclosing one. The
    // service layer composes transactions legitimately (a posting calls helpers
    // that each want atomicity), so this is a supported path, not a misuse.
    if (this.inTransaction || !this.beginFn) {
      return fn(this);
    }
    const begin = this.beginFn;
    const result = await begin(async (tx) => fn(tx));
    return result as T;
  }

  async close(): Promise<void> {
    // Closing is owned by PostgresDb; a bound handle must not end the pool.
    throw new Error('close() is only valid on the pool handle');
  }
}

/** Root handle over a connection pool. */
export class PostgresDb implements SqlDb {
  readonly dialect = 'postgres' as const;

  private readonly connection: PgConnection;
  private readonly root: PgRoot;

  constructor(options: PostgresDbOptions) {
    const ssl =
      options.ssl === 'disable'
        ? false
        : options.ssl === 'no-verify'
          ? { rejectUnauthorized: false }
          : ('require' as const);

    this.root = postgres(options.url, {
      ssl,
      max: options.max ?? 10,
      idle_timeout: 20,
      connect_timeout: 30,
      // Disable server-side prepared statements.
      //
      // postgres-js prepares statements and caches them per connection by
      // default. That breaks wherever the server-side session is not stable:
      //
      //   - Supabase's connection pooler (Supavisor, transaction mode) hands
      //     each transaction an arbitrary backend, so a statement prepared on
      //     one is missing on the next. The error is "unnamed prepared
      //     statement does not exist" (SQLSTATE 26000).
      //   - PGlite's socket server has the same limitation, which is how this
      //     surfaced in testing.
      //
      // The cost is one extra round trip per query (parse+bind on each call);
      // the benefit is that the service works through a pooler at all, which
      // is the default way a hosted Supabase database is reached.
      prepare: false,
      // See the header note: without this, every money value and COUNT(*)
      // arrives as a string.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (value: number | bigint) => value.toString(),
          parse: (raw: string) => Number.parseInt(raw, 10),
        },
        // numeric (OID 1700). Needed because SUM() over a bigint column
        // returns numeric, not int8 — and postgres-js returns numeric as a
        // string. Left alone, `0 + "0" + 0` is the string "0000", which is
        // !== 0, so any derived balance/status check silently takes the wrong
        // branch. Counts worked (int8), which is what made this look like a
        // status bug rather than a type bug.
        //
        // Money in this schema is bigint, so numeric only ever appears as an
        // aggregate over cents — far inside the safe-integer range. A value
        // that is not a safe integer is returned as its original string rather
        // than rounded, so a future fractional numeric surfaces loudly instead
        // of being silently truncated.
        numeric: {
          to: 1700,
          from: [1700],
          serialize: (value: number | string) => String(value),
          parse: (raw: string) => {
            const n = Number(raw);
            return Number.isSafeInteger(n) ? n : raw;
          },
        },
        // Date and timestamp columns are returned as JavaScript Date objects
        // by default, while SQLite returns ISO text. Domain code builds dates
        // from these values (`new Date(\`${due_date}T00:00:00Z\`)`), which a
        // Date object turns into an Invalid Date. Normalising here keeps the
        // domain layer identical on both backends — the point of the interface.
        date: {
          to: 1082,
          from: [1082],
          serialize: (value: string) => value,
          // 'YYYY-MM-DD', exactly as SQLite stores it.
          parse: (raw: string) => raw,
        },
        timestamp: {
          to: 1114,
          from: [1114],
          serialize: (value: string) => value,
          // Timestamps without a zone are written by us as UTC, so pin the
          // zone explicitly rather than letting the driver reinterpret them.
          parse: (raw: string) => new Date(`${raw.replace(' ', 'T')}Z`).toISOString(),
        },
        timestamptz: {
          to: 1184,
          from: [1184],
          serialize: (value: string) => value,
          parse: (raw: string) => new Date(raw).toISOString(),
        },
      },
    }) as unknown as PgRoot;

    // The transaction callback is handed a bound connection that cannot itself
    // begin (postgres-js has no nested transactions), so the begin function is
    // captured here and the bound handle is constructed with null.
    const root = this.root;
    const beginFn = async (fn: (tx: SqlDb) => Promise<unknown>): Promise<unknown> =>
      root.begin(async (tx) => {
        const bound = new PgConnection(tx, null, true);
        return fn(bound);
      });

    this.connection = new PgConnection(root, beginFn, false);
  }

  all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.connection.all<T>(sql, params);
  }

  get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    return this.connection.get<T>(sql, params);
  }

  run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    return this.connection.run(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.connection.exec(sql);
  }

  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn);
  }

  async close(): Promise<void> {
    await this.root.end({ timeout: 5 });
  }
}

export function openPostgres(options: PostgresDbOptions): SqlDb {
  return new PostgresDb(options);
}
