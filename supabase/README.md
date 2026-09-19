# Supabase

The ledger schema, ported from the SQLite development database to Postgres.

```
migrations/20260919000000_seller_ledger.sql   the schema
verify-migration.mjs                          runs + tests it against real Postgres
```

## Status

The **migration is written and verified**. The **Node service layer is still
SQLite-backed** — see "Porting the service layer" below for what that means
and what remains.

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

## Porting the service layer

The schema is done and verified; the backend is not yet ported.
`server/src/db/index.ts` uses `better-sqlite3`, which is **synchronous**.
Postgres via `postgres-js` or `@supabase/supabase-js` is **asynchronous**, so
the port is not a driver swap:

1. **Every service function becomes async**, and so does every caller up
   through `api.ts`. `services/plan.ts` and `services/ledger.ts` are the bulk
   of it.
2. **The posting transaction changes shape.** `better-sqlite3` gives a
   synchronous `IMMEDIATE` transaction wrapping straight-line code. Postgres
   needs `sql.begin(async (tx) => …)`, and every statement inside must be
   issued on `tx`, not on the pool. Getting this wrong is exactly the bug the
   atomicity tests exist to catch.
3. **Type conversions.** `bigint` comes back as a string from some drivers —
   note the view already returns `expected_balance_cents` as `"50000"`. The
   `parseAmountToCents`/`formatCents` helpers in `server/src/domain/money.ts`
   should own that boundary so cents never arrive as a string in domain code.
4. **Dates.** SQLite stores ISO text; Postgres `date`/`timestamptz` return
   `Date` objects. `entry_date` and `due_date` are `date` columns here.
5. **`datetime('now')` defaults are gone** — replaced with `now()`.

The 128 existing tests are the safety net for this port: they drive the
service layer through its public functions, so most of them should need only
an async/await lift and a Postgres test database.

## Environment

See `.env.example` in the repo root. The backend needs:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key — server-side only, never in a browser>
```

The service role key bypasses RLS. It must never be exposed to the frontend or
committed; the frontend should use the publishable/anon key with a user JWT if
it ever talks to Supabase directly.
