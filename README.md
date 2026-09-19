# MDC-Hackathon
MDC_Agentic_Hackathon

# Seller Ledger

A seller-scoped ledger write service with agent tools and an invoice-to-payment
reconciliation interface.

React + TypeScript frontend, Node + TypeScript backend, SQLite storage.

## Run it

```bash
npm install
npm run seed     # synthetic data, posted through the real service layer
npm run build
npm start        # http://localhost:4000
```

`npm start` serves both the API and the built UI from one origin, so there is
one URL to open: **http://localhost:4000**

For development with reload:

```bash
npm run dev        # API on :4000
npm run dev:web    # Vite dev server on :5173, proxying /api to :4000
```

Other commands:

```bash
npm test                  # 145 tests across 10 files (in-memory SQLite, ~300ms)
npm run typecheck
npm run verify:supabase   # runs the migration + seed against real Postgres
npm run test:postgres     # service layer against real Postgres (34 checks)
npm run test:postgres-http # full HTTP API against real Postgres (29 checks)
```

## Database

The service runs on **either** backend, chosen by connection string rather than
by `NODE_ENV`:

- **SQLite** (`server/data/ledger.db`) by default — zero setup, used by the
  test suite and local development.
- **Postgres / Supabase** when `SUPABASE_DB_URL` is set.

```bash
cp .env.example .env      # then set SUPABASE_DB_URL to point at Postgres
npm run seed              # seeds whichever backend is selected
npm start                 # startup logs which database it connected to
```

The service layer is written against a small async interface
(`server/src/db/sql-db.ts`) with one implementation per backend, so no service
code knows which database it is talking to. That is what the two Postgres
suites above verify: the dialect layer, the `?`→`$n` rewriting, `bigint`
handling, date normalisation, transaction binding and the HTTP routes.

See [`supabase/README.md`](supabase/README.md) for applying the schema to a
Supabase project and how to verify it.

## What it does

**Places invoices**, records confirmed payments, allocates them to invoices,
applies credit notes, records fees and refunds, and posts approved
adjustments. Every operation produces a balanced journal entry built from
configured account mappings — no service code hardcodes an account code.

Placing an invoice is deliberately two steps. `POST /invoices` creates the
document and schedules its reminder ladder but does **not** touch the ledger;
putting the receivable on the books is a separate `issue_invoice` proposal that
goes through the normal approve → post gate. That keeps the accounting entry
reviewable instead of a side effect of creating a document.

The books are seller-scoped. Two sellers are seeded with different
configurations, and an actor from one gets a 403 on the other.

## The controls

**Approval is required before posting.** A proposal is created first, a seller
user approves it, then it can be posted. Nothing is committed at propose time.

**An agent cannot approve its own proposal** — or anything at all. Approval
requires a human with an `approver` or `owner` role. Neither can a human
approve a proposal they raised themselves. Enforced in `services/ledger.ts`,
not in the UI.

**The preview shows what will happen before it happens** — the proposed debits
and credits, the affected invoices, the resulting balance changes, and the
supporting source records.

**State is revalidated immediately before commit.** Posting re-plans the
operation from its original input and compares the result against live state.
If a payment was allocated elsewhere or an invoice was settled in the
meantime, the posting is refused with `stale_state` naming the conflict.

**One transaction.** The journal entry, its lines, the subledger effect
(payment, allocation, credit note, fee, refund, adjustment), the invoice
balance changes, the audit event and the reminder recheck all commit together
or not at all.

**Duplicates cannot post twice.** Four independent defences:

| Defence | Catches |
| --- | --- |
| `idempotency_key` (UNIQUE, per seller) | a client retrying the same request |
| `source_event_id` (UNIQUE, per seller) | the same business event arriving twice |
| deterministic source-row ids | a retry creating a duplicate payment or allocation |
| optimistic version checks | a concurrent writer that got there first |

**Posted entries are immutable.** Database triggers refuse to edit or delete a
posted entry or its lines. Mistakes are corrected with a linked reversal and,
where needed, a replacement entry. A reversal is itself an entry, so it
reverses exactly once and can never be reversed again.

**Reminders follow settlement.** Reminder eligibility is rechecked inside the
same transaction as the posting that settled the invoice. An invoice with no
outstanding balance has its scheduled reminders suppressed with a recorded
reason; a refund or a reversed allocation reinstates them.

**Automatic posting is opt-in and narrow.** Disabled by default. A rule only
fires when explicitly enabled, and only on an *exact* match of every field it
declares, optionally under an amount ceiling. A rule with an empty matcher is
refused (it would authorise everything). The match evidence is stored on the
proposal so an auto-posted entry can always be explained.

## Local ledger vs external accounting system

These are different systems with different states and are never conflated.

`journal_entries.external_sync_state` is `not_applicable` when no platform is
connected. When a seller declares an external platform authoritative, a local
posting is marked `pending` — never `confirmed`. The state only advances to
`confirmed` when a platform acknowledgement carrying an `external_ref` is
recorded; the service refuses to mark a sync confirmed without one.

Attempt history lives in `external_sync_attempts`, so a failed push is visible
rather than silently retried into apparent success. A sync failure is not a
ledger failure — the local posting stands.

## Layout

```
server/
  src/db/schema.sql          19 tables; balance, immutability and idempotency
                             invariants enforced by triggers and constraints
  src/db/sql-db.ts           the async interface the service layer targets
  src/db/sqlite-db.ts        SQLite implementation (serialised transactions)
  src/db/postgres-db.ts      Postgres implementation (int8, dates, tx binding)
  src/domain/                money (integer cents), mappings, entry builder, errors
  src/services/              access, audit, journal, invoices, payments,
                             reminders, reconciliation, external sync,
                             auto-post rules, adjustments, agent tools,
                             plan.ts (each operation's accounting shape),
                             ledger.ts (propose → approve → post → reverse)
  src/api.ts                 HTTP routes
  src/seed.ts                synthetic data, posted via the real pipeline
  scripts/smoke-postgres.mjs     service layer against real Postgres
  scripts/verify-http-postgres.mjs  HTTP API against real Postgres
  tests/                     145 tests
web/
  src/                       reconciliation interface, proposal queue,
                             journal, reminders, adjustments, sync, audit,
                             agent tool console
supabase/
  migrations/                the Postgres schema, ported from schema.sql
  seed.sql                   reference and configuration data only
  verify-migration.mjs       executes the migration and asserts its invariants
  apply.mjs                  applies the schema to a Supabase project
```

## Account mappings

Operations declare `(mapping_key, side)` pairs; the seller's configured
`account_mappings` resolve them to accounts. Remapping an account is a data
change, not a code change.

| Operation | Debit | Credit |
| --- | --- | --- |
| issue invoice | accounts receivable (total) | revenue (net), tax payable (tax) |
| record payment | cash | unapplied cash |
| allocate payment | unapplied cash | accounts receivable |
| apply credit note | credit note (contra-revenue) | accounts receivable |
| record fee | fee expense | cash |
| record refund | refund expense | cash |
| adjustment (debit) | adjustment account | accounts receivable |
| adjustment (credit) | accounts receivable | adjustment account |

## Agent tools

| Tool | Mutates ledger | Requires human |
| --- | --- | --- |
| `preview_ledger_update` | no | no |
| `propose_ledger_update` | no | no |
| `approve_ledger_update` | yes | **yes** |
| `post_ledger_update` | yes | no |
| `reverse_ledger_entry` | yes | no |

An agent can propose, preview, post (once a human has approved) and reverse.
It cannot approve. The tools route through the same service functions the UI
uses, so an agent is subject to exactly the same controls as a human.

## Using the interface

The top bar switches the acting user and the seller. Switching the actor is
how the authorisation model becomes visible: an agent's Approve buttons are
disabled with the reason, and an actor with no membership of the selected
seller gets an explicit refusal rather than an empty screen.

The seeded database arrives with a proposal already pending, so there is
something to approve on first load.
