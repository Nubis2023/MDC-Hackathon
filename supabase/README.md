# Supabase

The ledger schema, ported from the SQLite development database to Postgres.

```
migrations/20260919000000_seller_ledger.sql   the schema
verify-migration.mjs                          runs + tests it against real Postgres
```

## Status

The **migration is written, applied, and verified**. The **service layer is
ported** and runs against either SQLite or Postgres — see "The service layer
port" below.

## Apply the migration

### Option A — this repo's apply script (works everywhere)

Connects directly over the Postgres protocol with a real connection string.
This is the path that works from a terminal that cannot use the Supabase CLI.

```bash
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"

npm run apply:supabase -- --dry-run          # show what would run
npm run apply:supabase                       # schema only
npm run apply:supabase -- --with-seed        # schema + reference/config seed
```

The whole migration runs in one transaction — if any statement fails, nothing
is applied. It reports table, RLS, policy and trigger counts afterward, and
warns if any table has RLS enabled with no policy (which would silently return
nothing to clients).

Get the connection string from **Project Settings → Database → Connection
string → URI**. Use the direct connection (port 5432), not the pooler, for
DDL.

### Option B — Supabase CLI (recommended if you have it)

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

The CLI reads `supabase/migrations/` and `supabase/seed.sql` from this repo;
`supabase/config.toml` is already in place.

### Option C — SQL editor

Paste `migrations/20260919000000_seller_ledger.sql` into the dashboard's SQL
editor and run it.

The migration is idempotent (`create table if not exists`,
`create or replace function`, `drop trigger if exists` before each
`create trigger`), so re-running it is safe. This is verified, not assumed —
see the idempotency checks below.

## Why the Mel MCP connection is not used

The connected Supabase MCP server rejects requests: its key is a
**publishable (browser) key**, which cannot reach a project. It needs a
personal access token scoped to the project. Until that is supplied, use the
apply script above — it needs only the database connection string.

## Verify it

```bash
node supabase/verify-migration.mjs
```

This executes the migration against a real Postgres (PGlite — Postgres
compiled to WASM), with the Supabase `auth` schema stubbed, then asserts:

- every table, trigger, function and RLS policy is created
- an unbalanced entry cannot be posted (both the one-line and non-zero-sum cases)
- a posted entry's memo, line amounts and line deletions are all refused
- duplicate `source_event_id` and reused `idempotency_key` are both refused
- an adjustment cannot be stored as approved without an approver
- an external sync cannot be recorded as confirmed without a platform reference
- an empty auto-post matcher is refused
- a payment allocation cannot be deleted
- **RLS actually holds**: a non-member reads zero rows of another seller's
  invoices, journal and memberships
- the reconciliation view reports drift when the cached balance is tampered with

It also checks what a fresh Supabase project actually needs: that every
RLS-enabled table has a policy (RLS with no policy denies everything, which
would silently break the app), that the journal tables are client
select-only, and that both the migration and the seed are **idempotent** —
re-running them changes no row counts and duplicates no triggers.

Current result: **48 checks, all passing.**

### Verifying the apply script itself

```bash
node supabase/test-apply.mjs
```

Runs `apply.mjs` as a **subprocess** against a real Postgres server — PGlite
behind `PGLiteSocketServer`, which speaks the actual Postgres wire protocol on
a TCP port — so connection handling, TLS selection, the transaction wrapper
and the multi-statement DDL are all genuinely exercised rather than mocked.

It also covers the failure path: an unreachable database exits non-zero and
prints that nothing was committed.

Current result: **17 checks, all passing.**

## What is enforced in the database

This matters more on Supabase than it did on SQLite. PostgREST exposes every
table in this schema over HTTP, so anything the database does not enforce, a
client holding a valid anon key can bypass. These live in the schema, not in
service code:

| Guarantee | Mechanism |
| --- | --- |
| An entry cannot post unbalanced | `trg_journal_entry_balance_on_post` |
| Posted entries and lines are immutable | `trg_journal_entry_immutable`, `trg_journal_line_immutable_*` |
| Allocations are reversed, never deleted | `trg_allocation_no_delete` |
| No duplicate business event | `unique (seller_id, source_event_id)` |
| No duplicate retry | partial unique index on `(seller_id, idempotency_key)` |
| An entry is reversed at most once | partial unique index on `reversal_of` |
| No unapproved adjustment | `adjustments_approval_required` check |
| No fabricated external confirmation | `sync_confirmed_needs_ref` check |
| No catch-all auto-post rule | `auto_rules_matcher_not_empty` check |
| Seller data cannot leak across tenants | RLS on all 17 seller-scoped tables |

## Row level security

Every seller-scoped table has RLS enabled with a member-scoped `select`
policy, and role-gated write policies for the operational tables. The journal,
lines and proposals are select-only for clients — the posting path owns those
transitions.

Two things to understand before relying on it:

**The service role bypasses RLS.** The Node backend connects with the service
role key, which is exempt. The application-level checks in
`server/src/services/access.ts` remain the first line of defence; RLS is the
second, covering direct client access, the JS client, and anything else that
reaches PostgREST without going through the backend.

**`auth.uid()` is the link.** `users.auth_user_id` (uuid, FK to
`auth.users`) connects a Supabase identity to a ledger user. The helper
`ledger_current_user_id()` resolves it, and every policy goes through
`ledger_is_seller_member()` or `ledger_has_seller_role()`. A user with no
`users` row, or with no membership of a seller, sees nothing.

## The service layer port

**Done.** The backend runs on either backend, chosen by connection string:

| | |
| --- | --- |
| `SUPABASE_DB_URL` set | Postgres (Supabase) |
| unset | SQLite at `DB_FILE` (tests, local dev) |

The service layer targets a small async interface (`server/src/db/sql-db.ts`)
with one implementation per backend, so no service code knows which database it
is talking to. `openDatabaseFromEnv()` in `server/src/db/index.ts` is the
switch.

Five things had to be handled, and each is a place where a naive port would
have silently corrupted data rather than failed:

1. **Every service function is async.** ~70 functions across 15 files, plus
   every caller up through `api.ts`.
2. **Transactions are bound.** On Postgres a statement issued on the pool
   instead of the transaction connection commits *independently* — so a
   rollback would not undo it. That is the exact guarantee the posting pipeline
   exists to provide. With a single-connection pool it is worse than a
   correctness bug: it deadlocks. `SqliteDb.transaction` passes `this` as the
   handle, so `db` and `tx` were the same object and SQLite hid the bug
   entirely.
3. **`numeric` as well as `bigint`.** Every money column is `bigint`, but
   `SUM()` over a `bigint` returns **`numeric`**, which postgres-js returns as
   a *string*. `0 + "0"` is `"0000"`, so every derived balance/status
   comparison took the wrong branch. `COUNT(*)` is `int8` and worked, which is
   what made this look like a status bug rather than a type bug. Both OIDs are
   parsed to `Number` in `postgres-db.ts`.
4. **Dates.** Postgres returns `date` columns as `Date` objects; SQLite returns
   ISO text. Domain code builds dates from those strings, so a `Date` object
   produced `Invalid Date`. The driver layer normalises them back to
   `YYYY-MM-DD`.
5. **Prepared statements are disabled** (`prepare: false`). postgres-js caches
   server-side prepared statements per connection by default, which breaks
   wherever the session is not stable — Supabase's connection pooler
   (Supavisor, transaction mode), and PGlite's socket server. The symptom is
   `unnamed prepared statement does not exist` (SQLSTATE 26000).

### Verifying it

```bash
npm test                     # 145 tests, in-memory SQLite, ~300ms
npm run test:postgres        # service layer against real Postgres (34 checks)
npm run test:postgres-http   # full HTTP API against real Postgres (29 checks)
```

Both Postgres suites start a real Postgres — PGlite behind
`PGLiteSocketServer`, which speaks the wire protocol — apply this migration,
and run against it. `test:postgres-http` boots the actual compiled server
(`dist/index.js`) with `SUPABASE_DB_URL` pointing at it and drives the HTTP
endpoints, so env loading, backend selection, the Express routes and the
dialect layer are all exercised together.

They deliberately do **not** target a live Supabase project: the tests write
data, and doing that against a real project would pollute it. PGlite is
Postgres, so the dialect behaviour is identical.

### Pool note

`SUPABASE_DB_POOL_MAX` controls the connection pool (default 10). It exists
because PGlite's socket implementation does not isolate session state across
concurrent connections, so the verification harness pins it to 1. Real
Postgres, including a Supabase project, needs no such setting.

## Environment

See `.env.example` in the repo root. The server loads `.env` at startup via
Node's `process.loadEnvFile` (no dotenv dependency); real environment variables
take precedence, so CI and hosted environments are unaffected.

To point the backend at Postgres, one variable is needed:

```
SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

Use the **direct** connection (port 5432). The connection pooler works too —
`prepare: false` is set precisely so it does — but the direct connection avoids
the pooler's transaction-mode caveats entirely.

The service role key is **not** needed to run the backend: it authenticates
against the Supabase API, whereas this service talks to Postgres directly. It
bypasses RLS, so if you do use it, keep it server-side and never commit it.
