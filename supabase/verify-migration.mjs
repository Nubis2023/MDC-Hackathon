/**
 * Verify the Supabase/Postgres migration actually runs and that its
 * invariants hold.
 *
 * This executes the migration against a real Postgres (PGlite, Postgres
 * compiled to WASM) with the Supabase-specific bits stubbed — the `auth`
 * schema and `auth.uid()` — so the DDL, the plpgsql trigger functions and
 * the RLS policies are all exercised as Postgres, not merely parsed.
 *
 * The point is to catch the class of error that reading the SQL cannot:
 * trigger functions that raise at runtime, constraints that are syntactically
 * legal but wrong, and RLS that fails open.
 *
 * Run: node supabase/verify-migration.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, 'migrations', '20260919000000_seller_ledger.sql');
const sql = readFileSync(migrationPath, 'utf8');

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed++;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, err) {
  failed++;
  console.log(`  \u2717 ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
}

async function expectReject(db, name, fn, pattern) {
  try {
    await fn();
    fail(name, `expected a rejection matching ${pattern}, but it succeeded`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (pattern && !pattern.test(msg)) {
      fail(name, `rejected, but message did not match ${pattern}: ${msg}`);
    } else {
      ok(name, msg.split('\n')[0].slice(0, 90));
    }
  }
}

async function expectAccept(db, name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

const db = new PGlite();

console.log('\nSupabase migration verification (real Postgres via PGlite)');
console.log('===========================================================\n');

// ── Supabase-specific stubs ────────────────────────────────────────────
// PGlite has no auth schema; Supabase provides it. Stub what the migration
// references so the rest can be tested for real.
console.log('Stubbing Supabase auth surface…');
await db.exec(`
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
  );

  -- Supabase defines auth.uid() off the request JWT. Here it reads a GUC so
  -- tests can impersonate a user and exercise the RLS policies.
  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;

  -- The migration revokes/grant EXECUTE on the roles Supabase creates.
  -- Bare Postgres has neither, so stub them here — this is what the real
  -- Supabase platform provides out of the box.
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end
  $$;
`);
ok('auth schema, auth.uid(), anon + authenticated roles available');

// ── Apply the migration ────────────────────────────────────────────────
console.log('\nApplying migration as Postgres…');
try {
  await db.exec(sql);
  ok('migration applied cleanly', `${sql.split('\n').length} lines`);
} catch (err) {
  fail('migration applied cleanly', err);
  console.log('\nCannot continue without a valid schema.');
  process.exit(1);
}

let seedSql = '';
// ── Apply the seed ─────────────────────────────────────────────────────
console.log('\nApplying seed.sql…');
try {
  seedSql = readFileSync(join(here, 'seed.sql'), 'utf8');
  await db.exec(seedSql);
  ok('seed.sql applied cleanly');
} catch (err) {
  fail('seed.sql applied cleanly', err);
}

const seededSellers = await db.query(`select count(*)::int as n from sellers`);
ok(`sellers after seed: ${seededSellers.rows[0].n}`);

const unmapped = await db.query(`
  select s.id from sellers s
   where not exists (select 1 from account_mappings m where m.seller_id = s.id)
`);
if (unmapped.rows.length === 0) {
  ok('every seller has account mappings');
} else {
  fail('every seller has account mappings', JSON.stringify(unmapped.rows));
}

// Every mapping must resolve to an account in the same seller, otherwise the
// entry builder fails at post time rather than at seed time.
const badMappings = await db.query(`
  select m.seller_id, m.mapping_key, m.side
    from account_mappings m
    left join gl_accounts a on a.seller_id = m.seller_id and a.id = m.account_id
   where a.id is null
`);
if (badMappings.rows.length === 0) {
  ok('every mapping resolves to an account in the same seller');
} else {
  fail('every mapping resolves to an account', JSON.stringify(badMappings.rows));
}

// The full set of keys the service can plan must be configured on both sides.
const ALL_KEYS = [
  'cash', 'unapplied_cash', 'accounts_receivable', 'revenue',
  'tax_payable', 'credit_note', 'fee_expense', 'refund_expense', 'adjustment',
];
// Each key x side is generated via separate CTEs. Putting two unnest() calls
// in one SELECT list would zip them, padding the shorter with NULL — which
// silently reports real mappings as missing.
const gaps = await db.query(
  `
  with keys as (select unnest($1::text[]) as mapping_key),
       sides as (select unnest(array['debit','credit']) as side)
  select s.id as seller_id, k.mapping_key, sd.side
    from sellers s
    cross join keys k
    cross join sides sd
    left join account_mappings m
      on m.seller_id = s.id
     and m.mapping_key = k.mapping_key
     and m.side = sd.side
   where m.account_id is null
   order by s.id, k.mapping_key, sd.side
  `,
  [ALL_KEYS],
);
if (gaps.rows.length === 0) {
  ok(`all ${ALL_KEYS.length} mapping keys configured on both sides for every seller`);
} else {
  fail('all mapping keys configured', JSON.stringify(gaps.rows.slice(0, 8)));
}

// The auto-post rule must ship disabled, so a fresh database requires approval.
// `enabled` is integer 0/1 (kept numeric for SQLite/Postgres parity).
const ruleRes = await db.query(
  `select enabled from auto_post_rules where id = 'rule_nw_fees'`,
);
if (ruleRes.rows.length === 1 && Number(ruleRes.rows[0].enabled) === 0) {
  ok('seeded auto-post rule ships disabled (approval required by default)');
} else {
  fail('seeded auto-post rule ships disabled', JSON.stringify(ruleRes.rows));
}

// Seed must not fabricate any financial history.
const noHistory = await db.query(`
  select
    (select count(*) from journal_entries) as entries,
    (select count(*) from payments)        as payments,
    (select count(*) from invoices)        as invoices
`);
const h = noHistory.rows[0];
if (Number(h.entries) === 0 && Number(h.payments) === 0) {
  ok('seed creates no journal or payment history (config only)');
} else {
  fail('seed creates no financial history', JSON.stringify(h));
}

// ── Structure ──────────────────────────────────────────────────────────
console.log('\nStructure');
const expectedTables = [
  'sellers', 'users', 'seller_memberships', 'gl_accounts', 'account_mappings',
  'invoices', 'payments', 'payment_allocations', 'credit_notes', 'fees',
  'refunds', 'adjustments', 'journal_entries', 'journal_lines',
  'ledger_proposals', 'auto_post_rules', 'audit_events',
  'external_sync_attempts', 'reminders',
];

const tableRes = await db.query(`
  select tablename from pg_tables where schemaname = 'public' order by tablename
`);
const tables = tableRes.rows.map((r) => r.tablename);
const missing = expectedTables.filter((t) => !tables.includes(t));
if (missing.length === 0) {
  ok(`all ${expectedTables.length} tables created`);
} else {
  fail('all tables created', `missing: ${missing.join(', ')}`);
}

const rlsRes = await db.query(`
  select tablename from pg_tables
   where schemaname = 'public' and rowsecurity = true
`);
ok(`RLS enabled on ${rlsRes.rows.length} tables`);

const trigRes = await db.query(`
  select tgname from pg_trigger where not tgisinternal order by tgname
`);
ok(`${trigRes.rows.length} triggers installed`, trigRes.rows.map((r) => r.tgname).join(', '));

const fnRes = await db.query(`
  select proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and proname like 'ledger%'
   order by proname
`);
ok(`${fnRes.rows.length} ledger functions`, fnRes.rows.map((r) => r.proname).join(', '));

// ── Fixtures ───────────────────────────────────────────────────────────
console.log('\nFixtures');
await db.exec(`
  insert into sellers (id, name, currency, authoritative_system)
  values ('s1', 'Test Seller', 'USD', 'local');

  insert into users (id, name, kind) values
    ('u1', 'Owner', 'human'),
    ('u2', 'Approver', 'human'),
    ('agent', 'Agent', 'agent');

  insert into seller_memberships (seller_id, user_id, role) values
    ('s1', 'u1', 'owner'),
    ('s1', 'u2', 'approver'),
    ('s1', 'agent', 'bookkeeper');

  insert into gl_accounts (id, seller_id, code, name, type) values
    ('cash', 's1', '1000', 'Cash', 'asset'),
    ('ar', 's1', '1100', 'AR', 'asset'),
    ('rev', 's1', '4000', 'Revenue', 'revenue');

  insert into invoices
    (id, seller_id, customer_name, number, issue_date, due_date,
     subtotal_cents, tax_cents, total_cents, balance_cents, status)
  values ('inv1', 's1', 'Cust', 'INV-1', '2026-08-01', '2026-09-01',
          100000, 0, 100000, 100000, 'open');
`);
ok('seller, users, memberships, accounts, invoice inserted');

// The invoice total check is a real constraint worth confirming.
await expectReject(
  db,
  'invoice with total != subtotal + tax is refused',
  () =>
    db.exec(`
      insert into invoices
        (id, seller_id, customer_name, number, issue_date, due_date,
         subtotal_cents, tax_cents, total_cents, balance_cents, status)
      values ('bad', 's1', 'C', 'BAD', '2026-08-01', '2026-09-01',
              100, 50, 999, 999, 'open')
    `),
  /invoices_total_matches_parts/,
);

// ── Invariant: balance on post ─────────────────────────────────────────
console.log('\nInvariant: an unbalanced entry cannot be posted');

await db.exec(`
  insert into journal_entries
    (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
     source_event_id, entry_kind, status)
  values ('je1', 's1', 1, '2026-09-01', 'unbalanced', 'test', 'x', 'evt1', 'standard', 'pending');

  insert into journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
  values ('jl1', 's1', 'je1', 1, 'cash', 500);
`);

await expectReject(
  db,
  'single-line entry cannot be posted',
  () =>
    db.exec(`update journal_entries set status = 'posted', posted_at = now() where id = 'je1'`),
  /at least two lines/,
);

// Add a second line that still does not balance.
await db.exec(`
  insert into journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
  values ('jl2', 's1', 'je1', 2, 'rev', -400);
`);
await expectReject(
  db,
  'non-zero-sum entry cannot be posted',
  () =>
    db.exec(`update journal_entries set status = 'posted', posted_at = now() where id = 'je1'`),
  /sum to zero/,
);

// Fix the imbalance; the same statement must now succeed.
await db.exec(`
  update journal_lines set amount_cents = -500 where id = 'jl2';
`);
await expectAccept(db, 'balanced entry posts successfully', () =>
  db.exec(`update journal_entries set status = 'posted', posted_at = now() where id = 'je1'`),
);

// ── Invariant: immutability ────────────────────────────────────────────
console.log('\nInvariant: posted entries are immutable');

await expectReject(
  db,
  'memo of a posted entry cannot change',
  () => db.exec(`update journal_entries set memo = 'tampered' where id = 'je1'`),
  /immutable/,
);

await expectReject(
  db,
  'amount of a posted line cannot change',
  () => db.exec(`update journal_lines set amount_cents = 999 where id = 'jl1'`),
  /immutable/,
);

await expectReject(
  db,
  'a posted line cannot be deleted',
  () => db.exec(`delete from journal_lines where id = 'jl1'`),
  /immutable/,
);

await expectAccept(db, 'status may still move to reversed', () =>
  db.exec(`update journal_entries set status = 'reversed' where id = 'je1'`),
);

// ── Duplicate defence ──────────────────────────────────────────────────
console.log('\nDuplicate defence');

await expectReject(
  db,
  'same source_event_id for one seller is refused',
  () =>
    db.exec(`
      insert into journal_entries
        (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
         source_event_id, entry_kind, status)
      values ('je_dup', 's1', 2, '2026-09-01', 'dup', 'test', 'y', 'evt1', 'standard', 'pending')
    `),
  /duplicate key|unique/i,
);

await expectReject(
  db,
  'same idempotency_key for one seller is refused',
  () =>
    db.exec(`
      insert into journal_entries
        (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
         source_event_id, idempotency_key, entry_kind, status)
      values ('je_a', 's1', 3, '2026-09-01', 'a', 'test', 'z', 'evt_a', 'key-1', 'standard', 'pending');
      insert into journal_entries
        (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
         source_event_id, idempotency_key, entry_kind, status)
      values ('je_b', 's1', 4, '2026-09-01', 'b', 'test', 'w', 'evt_b', 'key-1', 'standard', 'pending');
    `),
  /duplicate key|unique/i,
);

// ── Invariant: no unapproved adjustment ────────────────────────────────
console.log('\nInvariant: an unapproved adjustment is not representable');

await expectReject(
  db,
  "adjustment cannot be 'approved' without an approver",
  () =>
    db.exec(`
      insert into adjustments (id, seller_id, amount_cents, direction, mapping_key, memo, status)
      values ('adj_bad', 's1', 500, 'debit', 'adjustment', 'x', 'approved')
    `),
  /adjustments_approval_required/,
);

await expectAccept(db, 'draft adjustment without approver is allowed', () =>
  db.exec(`
    insert into adjustments (id, seller_id, amount_cents, direction, mapping_key, memo, status)
    values ('adj_ok', 's1', 500, 'debit', 'adjustment', 'x', 'draft')
  `),
);

// ── Invariant: no fabricated external confirmation ─────────────────────
console.log('\nInvariant: an external sync cannot be confirmed without a reference');

// Needs a posted entry + allocation-free path; reuse je1 (already reversed)
// by posting a fresh entry.
await db.exec(`
  insert into journal_entries
    (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
     source_event_id, entry_kind, status)
  values ('je2', 's1', 10, '2026-09-02', 'pay', 'record_payment', 'p1', 'evt2', 'standard', 'pending');
  insert into journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
  values ('jl3', 's1', 'je2', 1, 'cash', 1000), ('jl4', 's1', 'je2', 2, 'rev', -1000);
  update journal_entries set status = 'posted', posted_at = now() where id = 'je2';
`);

await expectReject(
  db,
  'confirmed sync without external_ref is refused',
  () =>
    db.exec(`
      insert into external_sync_attempts (id, seller_id, entry_id, platform, state)
      values ('sync_bad', 's1', 'je2', 'demo', 'confirmed')
    `),
  /sync_confirmed_needs_ref/,
);

await expectAccept(db, 'confirmed sync with a platform reference is allowed', () =>
  db.exec(`
    insert into external_sync_attempts (id, seller_id, entry_id, platform, state, external_ref)
    values ('sync_ok', 's1', 'je2', 'demo', 'confirmed', 'PLATFORM-1')
  `),
);

// ── Invariant: auto-post matcher cannot be empty ───────────────────────
console.log('\nInvariant: an empty auto-post matcher is refused');

await expectReject(
  db,
  'empty match_json is refused',
  () =>
    db.exec(`
      insert into auto_post_rules (id, seller_id, name, proposal_kind, match_json, created_by)
      values ('rule_bad', 's1', 'catch-all', 'record_fee', '{}'::jsonb, 'u1')
    `),
  /auto_rules_matcher_not_empty/,
);

await expectAccept(db, 'a specific matcher is allowed', () =>
  db.exec(`
    insert into auto_post_rules (id, seller_id, name, proposal_kind, match_json, created_by)
    values ('rule_ok', 's1', 'fees', 'record_fee', '{"description":"Card fee"}'::jsonb, 'u1')
  `),
);

// ── Invariant: allocations are not deletable ───────────────────────────
console.log('\nInvariant: allocations are reversed, not deleted');

await db.exec(`
  insert into payments (id, seller_id, amount_cents, received_at, status, unallocated_cents)
  values ('pay1', 's1', 50000, now(), 'confirmed', 50000);
  insert into payment_allocations (id, seller_id, payment_id, invoice_id, amount_cents, status)
  values ('alloc1', 's1', 'pay1', 'inv1', 50000, 'active');

  -- Keep the cached balance consistent with the allocation, which is what the
  -- posting transaction does in one step. Without this the fixture itself is
  -- inconsistent and the view would rightly report drift.
  update invoices set balance_cents = total_cents - 50000 where id = 'inv1';
`);
await expectReject(
  db,
  'deleting an allocation is refused',
  () => db.exec(`delete from payment_allocations where id = 'alloc1'`),
  /reversed, not deleted/,
);

// ── Row level security ─────────────────────────────────────────────────
console.log('\nRow level security (as a non-bypassing role)');

// PGlite runs as superuser, which bypasses RLS. Create a plain role and
// impersonate it so the policies are genuinely exercised.
await db.exec(`
  create role app_user nologin;
  grant usage on schema public to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public to app_user;
`);

const memberUid = '11111111-1111-1111-1111-111111111111';
const otherUid = '22222222-2222-2222-2222-222222222222';

// users.auth_user_id has a real FK to auth.users, so the Supabase-side
// identity rows must exist first. That FK is worth keeping — it is what stops
// a ledger user being linked to a uuid that is not an actual auth identity.
await db.exec(`
  insert into auth.users (id, email) values
    ('${memberUid}', 'owner@example.test'),
    ('${otherUid}', 'other@example.test');

  update users set auth_user_id = '${memberUid}' where id = 'u1';
  insert into sellers (id, name) values ('s2', 'Other Seller');
  insert into users (id, name, kind, auth_user_id) values ('u9', 'Other', 'human', '${otherUid}');
  insert into seller_memberships (seller_id, user_id, role) values ('s2', 'u9', 'owner');
`);
ok('auth identities linked to ledger users');

async function asUser(uid, fn) {
  await db.exec(`set role app_user; select set_config('test.uid', '${uid}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

// A member of s1 sees s1 rows.
await asUser(memberUid, async () => {
  const res = await db.query(`select count(*)::int as n from invoices where seller_id = 's1'`);
  if (res.rows[0].n > 0) ok('member can read their own seller\'s invoices', `${res.rows[0].n} rows`);
  else fail('member can read their own seller\'s invoices', 'saw 0 rows');
});

// A non-member sees nothing from s1 — this is the seller isolation that
// matters most on Supabase, where PostgREST exposes the table.
await asUser(otherUid, async () => {
  const res = await db.query(`select count(*)::int as n from invoices where seller_id = 's1'`);
  if (res.rows[0].n === 0) ok('non-member sees zero rows of another seller (RLS holds)');
  else fail('non-member sees zero rows of another seller', `leaked ${res.rows[0].n} rows`);
});

// And cannot read the journal either.
await asUser(otherUid, async () => {
  const res = await db.query(`select count(*)::int as n from journal_entries where seller_id = 's1'`);
  if (res.rows[0].n === 0) ok('non-member sees zero journal entries of another seller');
  else fail('non-member sees zero journal entries', `leaked ${res.rows[0].n} rows`);
});

// Membership table is likewise scoped.
await asUser(otherUid, async () => {
  const res = await db.query(`select count(*)::int as n from seller_memberships where seller_id = 's1'`);
  if (res.rows[0].n === 0) ok('non-member cannot enumerate another seller\'s memberships');
  else fail('non-member cannot enumerate memberships', `leaked ${res.rows[0].n} rows`);
});

// ── Reconciliation view ────────────────────────────────────────────────
console.log('\nReconciliation view');

const recRes = await db.query(`
  select number, stored_balance_cents, expected_balance_cents, drift_cents
    from invoice_reconciliation where seller_id = 's1' order by number
`);
if (recRes.rows.length > 0) {
  ok('invoice_reconciliation returns rows', `${recRes.rows.length}`);
  const drifted = recRes.rows.filter((r) => Number(r.drift_cents) !== 0);
  if (drifted.length === 0) {
    ok('no drift on a consistent ledger');
  } else {
    fail('no drift on a consistent ledger', JSON.stringify(drifted));
  }
} else {
  fail('invoice_reconciliation returns rows', 'view returned nothing');
}

// Introduce drift deliberately and confirm the view surfaces it.
await db.exec(`update invoices set balance_cents = 12345 where id = 'inv1'`);
const driftRes = await db.query(
  `select drift_cents from invoice_reconciliation where invoice_id = 'inv1'`,
);
if (Number(driftRes.rows[0].drift_cents) !== 0) {
  ok('view reports drift when the cached balance is tampered with', `drift=${driftRes.rows[0].drift_cents}`);
} else {
  fail('view reports drift', 'drift reported as 0');
}

// ── RLS policies ───────────────────────────────────────────────────────
console.log('\nRLS policy coverage');
const polRes = await db.query(`
  select tablename, count(*)::int as n
    from pg_policies where schemaname = 'public'
   group by tablename order by tablename
`);
const coveredTables = polRes.rows.map((r) => r.tablename);
const selCount = polRes.rows.reduce((s, r) => s + r.n, 0);
ok(`${selCount} policies across ${polRes.rows.length} tables`);

// Every table with RLS enabled must actually have a policy. RLS with no
// policy denies everything, which is safe but would silently break the app.
const rlsNoPolicy = await db.query(`
  select t.tablename from pg_tables t
   where t.schemaname = 'public' and t.rowsecurity = true
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = t.tablename)
`);
if (rlsNoPolicy.rows.length === 0) {
  ok('every RLS-enabled table has at least one policy');
} else {
  fail(
    'every RLS-enabled table has at least one policy',
    `no policy on: ${rlsNoPolicy.rows.map((r) => r.tablename).join(', ')}`,
  );
}

// The three tables holding the ledger itself must be select-only for
// clients: the posting path owns their transitions.
for (const t of ['journal_entries', 'journal_lines', 'ledger_proposals']) {
  const kinds = polRes.rows.find((r) => r.tablename === t);
  const cmds = await db.query(
    `select distinct cmd from pg_policies where schemaname='public' and tablename=$1`,
    [t],
  );
  const cmdsList = cmds.rows.map((r) => r.cmd);
  const onlySelect = cmdsList.every((c) => c === 'SELECT');
  if (onlySelect && kinds) {
    ok(`${t} is client select-only`);
  } else {
    fail(`${t} is client select-only`, `commands: ${cmdsList.join(', ')}`);
  }
}

// ── Hardening (folded back into the migration) ─────────────────────────
// These were fixed on the live database after get_advisors flagged them; the
// migration must now produce them on a fresh apply. Assert that, rather than
// trusting the SQL to have been typed correctly.
console.log('\nHardening (search_path pinning + anon EXECUTE revocation)');

// 1. Every ledger trigger function must have a pinned search_path, so a
//    shadowed table in another schema cannot hijack a trigger.
const triggerFns = await db.query(`
  select p.proname, coalesce(array_to_string(p.proconfig, ','), '') as config
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'ledger_assert_%'
   order by p.proname
`);
const unpinned = triggerFns.rows.filter((r) => !String(r.config).includes('search_path=public'));
if (unpinned.length === 0 && triggerFns.rows.length > 0) {
  ok(`all ${triggerFns.rows.length} trigger functions have a pinned search_path`);
} else {
  fail(
    'all trigger functions have a pinned search_path',
    `unpinned: ${unpinned.map((r) => r.proname).join(', ')}`,
  );
}

// 2. The RLS helpers must not be EXECUTE-able by `anon`.
const helperGrants = await db.query(`
  select p.proname,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in
         ('ledger_current_user_id', 'ledger_is_seller_member', 'ledger_has_seller_role')
   order by p.proname
`);
const anonCan = helperGrants.rows.filter((r) => r.anon_can === true);
const authCannot = helperGrants.rows.filter((r) => r.auth_can !== true);
if (anonCan.length === 0 && authCannot.length === 0 && helperGrants.rows.length === 3) {
  ok('RLS helpers: anon revoked, authenticated retained');
} else {
  fail(
    'RLS helpers: anon revoked, authenticated retained',
    JSON.stringify({
      anon_can: anonCan.map((r) => r.proname),
      auth_cannot: authCannot.map((r) => r.proname),
    }),
  );
}

// ── Idempotency ────────────────────────────────────────────────────────
// Supabase users re-run migrations routinely, and the docs claim this is
// safe. Verify it rather than assert it.
console.log('\nIdempotency: re-running must be safe');

const beforeSellers = await db.query(`select count(*)::int as n from sellers`);
const beforeMappings = await db.query(`select count(*)::int as n from account_mappings`);

await expectAccept(db, 'migration re-applies without error', () => db.exec(sql));
await expectAccept(db, 'seed re-applies without error', () => db.exec(seedSql));

const afterSellers = await db.query(`select count(*)::int as n from sellers`);
const afterMappings = await db.query(`select count(*)::int as n from account_mappings`);

if (
  afterSellers.rows[0].n === beforeSellers.rows[0].n &&
  afterMappings.rows[0].n === beforeMappings.rows[0].n
) {
  ok('row counts unchanged after re-run', `${afterSellers.rows[0].n} sellers, ${afterMappings.rows[0].n} mappings`);
} else {
  fail(
    'row counts unchanged after re-run',
    `sellers ${beforeSellers.rows[0].n}->${afterSellers.rows[0].n}, ` +
      `mappings ${beforeMappings.rows[0].n}->${afterMappings.rows[0].n}`,
  );
}

// Triggers must not have been duplicated by the re-run.
const trigAfter = await db.query(`
  select tgname, count(*)::int as n from pg_trigger
   where not tgisinternal group by tgname having count(*) > 1
`);
if (trigAfter.rows.length === 0) {
  ok('no duplicate triggers after re-run');
} else {
  fail('no duplicate triggers after re-run', JSON.stringify(trigAfter.rows));
}

// ── Summary ────────────────────────────────────────────────────────────
console.log('\n===========================================================');
console.log(`${passed} passed, ${failed} failed`);
console.log('===========================================================\n');

process.exit(failed === 0 ? 0 : 1);
