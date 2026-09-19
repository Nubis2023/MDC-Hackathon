/**
 * Postgres smoke test.
 *
 * The full 128-test suite runs on in-memory SQLite in ~300ms. Running all of
 * it against PGlite is slow — PGlite is single-threaded WASM, so every test
 * serialises through one instance and each truncates its tables. This checks
 * only what actually differs between the two backends.
 *
 * Written as .mjs importing the compiled dist/ output: the server builds as
 * CommonJS, so a .ts script using top-level await fails to transform. Plain
 * ESM supports top-level await natively.
 *
 * Run: node server/scripts/smoke-postgres.mjs   (after `npm run build`)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const repoRoot = join(serverRoot, '..');

const { openPostgres } = await import(
  join(serverRoot, 'dist', 'db', 'postgres-db.js')
);
const { MAPPING_KEYS } = await import(
  join(serverRoot, 'dist', 'domain', 'types.js')
);
const {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
} = await import(join(serverRoot, 'dist', 'services', 'ledger.js'));
const { deriveInvoiceState } = await import(
  join(serverRoot, 'dist', 'services', 'invoices.js')
);
const { reconcileSeller } = await import(
  join(serverRoot, 'dist', 'services', 'reconciliation.js')
);

const SELLER = 'seller_smoke';
const PORT = 55440;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const OWNER = { id: 'u_owner', name: 'Owner', kind: 'human' };
const APPROVER = { id: 'u_approver', name: 'Approver', kind: 'human' };
const AGENT = { id: 'u_agent', name: 'Agent', kind: 'agent' };

const ACCOUNTS = [
  ['cash', '1000', 'Cash', 'asset'],
  ['unapplied', '1010', 'Unapplied Cash', 'liability'],
  ['ar', '1100', 'Accounts Receivable', 'asset'],
  ['tax', '2200', 'Tax Payable', 'liability'],
  ['revenue', '4000', 'Revenue', 'revenue'],
  ['credit_note', '4100', 'Credits', 'revenue'],
  ['fee', '6100', 'Fees', 'expense'],
  ['refund', '6200', 'Refunds', 'expense'],
  ['adjustment', '6300', 'Adjustments', 'expense'],
];

const MAPPING_TARGETS = {
  [MAPPING_KEYS.CASH]: 'cash',
  [MAPPING_KEYS.UNAPPLIED_CASH]: 'unapplied',
  [MAPPING_KEYS.AR]: 'ar',
  [MAPPING_KEYS.REVENUE]: 'revenue',
  [MAPPING_KEYS.TAX_PAYABLE]: 'tax',
  [MAPPING_KEYS.CREDIT_NOTE]: 'credit_note',
  [MAPPING_KEYS.FEE_EXPENSE]: 'fee',
  [MAPPING_KEYS.REFUND]: 'refund',
  [MAPPING_KEYS.ADJUSTMENT]: 'adjustment',
};

console.log('\nPostgres smoke test (PGlite over the wire protocol)');
console.log('===================================================\n');

const pglite = new PGlite();
await pglite.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
  );
  create or replace function auth.uid()
  returns uuid language sql stable
  as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

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

await pglite.exec(
  readFileSync(
    join(repoRoot, 'supabase', 'migrations', '20260919000000_seller_ledger.sql'),
    'utf8',
  ),
);
console.log('migration applied\n');

const server = new PGLiteSocketServer({
  db: pglite,
  port: PORT,
  host: '127.0.0.1',
  // Defaults to ONE connection; the driver pool needs more, and the default
  // resets the second connection (ECONNRESET).
  maxConnections: 10,
});
await server.start();

const db = openPostgres({
  url: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  ssl: 'disable',
  max: 1,
});

try {
  // ── Fixtures ────────────────────────────────────────────────────────
  await db.run(
    `insert into sellers (id, name, currency, authoritative_system) values (?, ?, 'USD', 'local')`,
    [SELLER, 'Smoke Seller'],
  );
  for (const u of [OWNER, APPROVER, AGENT]) {
    await db.run(`insert into users (id, name, kind) values (?, ?, ?)`, [
      u.id,
      u.name,
      u.kind,
    ]);
  }
  for (const [uid, role] of [
    [OWNER.id, 'owner'],
    [APPROVER.id, 'approver'],
    [AGENT.id, 'bookkeeper'],
  ]) {
    await db.run(
      `insert into seller_memberships (seller_id, user_id, role) values (?, ?, ?)`,
      [SELLER, uid, role],
    );
  }
  for (const [suffix, code, name, type] of ACCOUNTS) {
    await db.run(
      `insert into gl_accounts (id, seller_id, code, name, type) values (?, ?, ?, ?, ?)`,
      [`${SELLER}__${suffix}`, SELLER, code, name, type],
    );
  }
  for (const [key, target] of Object.entries(MAPPING_TARGETS)) {
    for (const side of ['debit', 'credit']) {
      await db.run(
        `insert into account_mappings (seller_id, mapping_key, side, account_id)
         values (?, ?, ?, ?)`,
        [SELLER, key, side, `${SELLER}__${target}`],
      );
    }
  }

  // ── Dialect basics ──────────────────────────────────────────────────
  console.log('Dialect basics');

  const one = await db.get(`select ?::int as n`, [42]);
  check('? -> $1 rewriting works', one?.n === 42, JSON.stringify(one));

  const counted = await db.get(
    `select count(*)::int as n from gl_accounts where seller_id = ?`,
    [SELLER],
  );
  check(
    'count(*) comes back as a number',
    typeof counted?.n === 'number' && counted.n === ACCOUNTS.length,
    `${typeof counted?.n}: ${counted?.n}`,
  );

  const literal = await db.get(`select 'a?b' as s`);
  check("a literal '?' in a string is left alone", literal?.s === 'a?b', literal?.s);

  const big = await db.get(`select 50000::bigint as v`);
  check(
    'int8 arrives as a number, not a string',
    typeof big?.v === 'number' && big.v === 50000,
    `${typeof big?.v}: ${big?.v}`,
  );

  // SUM() over bigint returns numeric, which postgres-js hands back as a
  // string by default. That turns `0 + "0"` into "0000", so every derived
  // status comparison silently takes the wrong branch.
  const summed = await db.get(
    `select coalesce(sum(amount_cents), 0) as s from journal_lines where seller_id = ?`,
    [SELLER],
  );
  check(
    'SUM over bigint arrives as a number, not a string',
    typeof summed?.s === 'number',
    `${typeof summed?.s}: ${JSON.stringify(summed?.s)}`,
  );

  // ── Invoice and posting ─────────────────────────────────────────────
  console.log('\nPosting to the ledger');

  await db.run(
    `insert into invoices
       (id, seller_id, customer_name, number, issue_date, due_date, currency,
        subtotal_cents, tax_cents, total_cents, balance_cents, status, version)
     values (?, ?, 'Smoke Customer', 'INV-S1', '2026-09-01', '2026-10-01', 'USD',
             100000, 8000, 108000, 108000, 'open', 1)`,
    ['inv_smoke', SELLER],
  );
  await db.run(
    `insert into reminders (id, seller_id, invoice_id, kind, status, scheduled_for)
     values ('rem_smoke', ?, 'inv_smoke', 'overdue', 'scheduled', '2026-10-02')`,
    [SELLER],
  );

  const invRow = await db.get(
    `select due_date, issue_date from invoices where id = ?`,
    ['inv_smoke'],
  );
  check(
    'date column returns YYYY-MM-DD text, not a Date object',
    typeof invRow?.due_date === 'string' &&
      /^\d{4}-\d{2}-\d{2}/.test(String(invRow.due_date)),
    `${typeof invRow?.due_date} ${JSON.stringify(invRow?.due_date)}`,
  );

  const issueProposal = await proposeLedgerUpdate(db, AGENT, {
    kind: 'issue_invoice',
    seller_id: SELLER,
    invoice_id: 'inv_smoke',
  });
  await approveLedgerUpdate(db, APPROVER, issueProposal.id, { reason: 'smoke' });
  const issuePosted = await postLedgerUpdate(db, APPROVER, issueProposal.id);
  check('issue_invoice posted to Postgres', Boolean(issuePosted.entry_id));

  const balanced = await db.get(
    `select coalesce(sum(amount_cents), 0) as total, count(*)::int as lines
       from journal_lines where entry_id = ?`,
    [issuePosted.entry_id],
  );
  check(
    'entry lines sum to zero',
    Number(balanced?.total) === 0 && Number(balanced?.lines) >= 2,
    `total=${balanced?.total} lines=${balanced?.lines}`,
  );

  const entryNo = await db.get(`select entry_no from journal_entries where id = ?`, [
    issuePosted.entry_id,
  ]);
  check('entry_no is a number', typeof entryNo?.entry_no === 'number', typeof entryNo?.entry_no);

  // ── Payment and allocation ──────────────────────────────────────────
  console.log('\nPayment and allocation');

  const payProposal = await proposeLedgerUpdate(db, AGENT, {
    kind: 'record_payment',
    seller_id: SELLER,
    amount_cents: 50000,
    received_at: '2026-09-10T12:00:00.000Z',
    reference: 'SMOKE-PAY-1',
    payer_name: 'Smoke Customer',
  });
  await approveLedgerUpdate(db, APPROVER, payProposal.id, { reason: 'smoke' });
  await postLedgerUpdate(db, APPROVER, payProposal.id);

  const payment = await db.get(
    `select id, amount_cents, unallocated_cents from payments where seller_id = ? and reference = ?`,
    [SELLER, 'SMOKE-PAY-1'],
  );
  check(
    'payment amount is a number',
    typeof payment?.amount_cents === 'number' && payment.amount_cents === 50000,
    `${typeof payment?.amount_cents}: ${payment?.amount_cents}`,
  );

  const allocProposal = await proposeLedgerUpdate(db, AGENT, {
    kind: 'allocate_payment',
    seller_id: SELLER,
    payment_id: payment.id,
    invoice_id: 'inv_smoke',
    amount_cents: 50000,
  });
  await approveLedgerUpdate(db, APPROVER, allocProposal.id, { reason: 'smoke' });
  await postLedgerUpdate(db, APPROVER, allocProposal.id);

  const derived = await deriveInvoiceState(db, 'inv_smoke');
  check('invoice balance reflects the allocation', derived.balance_cents === 58000, `${derived.balance_cents}`);
  check('invoice status is partially_paid', derived.status === 'partially_paid', derived.status);

  // Settle the rest, which should suppress the reminder in-transaction.
  const pay2 = await proposeLedgerUpdate(db, AGENT, {
    kind: 'record_payment',
    seller_id: SELLER,
    amount_cents: 58000,
    received_at: '2026-09-11T12:00:00.000Z',
    reference: 'SMOKE-PAY-2',
    payer_name: 'Smoke Customer',
  });
  await approveLedgerUpdate(db, APPROVER, pay2.id, { reason: 'smoke' });
  await postLedgerUpdate(db, APPROVER, pay2.id);
  const p2 = await db.get(`select id from payments where seller_id = ? and reference = ?`, [
    SELLER,
    'SMOKE-PAY-2',
  ]);
  const alloc2 = await proposeLedgerUpdate(db, AGENT, {
    kind: 'allocate_payment',
    seller_id: SELLER,
    payment_id: p2.id,
    invoice_id: 'inv_smoke',
    amount_cents: 58000,
  });
  await approveLedgerUpdate(db, APPROVER, alloc2.id, { reason: 'smoke' });
  const alloc2Posted = await postLedgerUpdate(db, APPROVER, alloc2.id);

  const reminder = await db.get(
    `select status, suppressed_reason from reminders where id = 'rem_smoke'`,
  );
  check(
    'settling the invoice suppressed its reminder',
    reminder?.status === 'suppressed' && reminder.suppressed_reason === 'invoice_settled',
    `${reminder?.status} / ${reminder?.suppressed_reason}`,
  );

  // ── Transactions ────────────────────────────────────────────────────
  console.log('\nTransactions');

  const before = await db.get(`select count(*)::int as n from journal_entries`);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      await tx.run(
        `insert into journal_entries
           (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
            source_event_id, entry_kind, status)
         values ('je_smoke_bad', ?, 9999, '2026-09-01', 'unbalanced', 'smoke', 'x',
                 'evt_smoke_bad', 'standard', 'pending')`,
        [SELLER],
      );
      await tx.run(
        `insert into journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
         values ('jl_smoke_bad', ?, 'je_smoke_bad', 1, ?, 500)`,
        [SELLER, `${SELLER}__cash`],
      );
      await tx.run(
        `update journal_entries set status = 'posted', posted_at = now() where id = 'je_smoke_bad'`,
      );
    });
  } catch {
    rolledBack = true;
  }
  check('balance trigger aborts an unbalanced post', rolledBack);

  const after = await db.get(`select count(*)::int as n from journal_entries`);
  check(
    'the failed transaction left nothing behind',
    Number(after?.n) === Number(before?.n),
    `${before?.n} -> ${after?.n}`,
  );

  const stray = await db.get(
    `select count(*)::int as n from journal_entries where id = 'je_smoke_bad'`,
  );
  check('no stray pending entry survived', Number(stray?.n) === 0, `${stray?.n}`);

  // ── Immutability ────────────────────────────────────────────────────
  console.log('\nImmutability');

  let memoFrozen = false;
  try {
    await db.run(`update journal_entries set memo = 'tampered' where id = ?`, [
      issuePosted.entry_id,
    ]);
  } catch {
    memoFrozen = true;
  }
  check('a posted memo cannot be edited', memoFrozen);

  let lineFrozen = false;
  try {
    await db.run(`delete from journal_lines where entry_id = ?`, [issuePosted.entry_id]);
  } catch {
    lineFrozen = true;
  }
  check('a posted line cannot be deleted', lineFrozen);

  // ── Reversal ────────────────────────────────────────────────────────
  console.log('\nReversal');

  // Reverse the settling allocation, not the invoice issuance: reversing an
  // issuance is refused once payments have been applied to it, and that
  // refusal is correct behaviour (the dependents must be reversed first).
  // Reversing an allocation also exercises reverseEffects on the subledger.
  const reversed = await reverseLedgerEntry(
    db,
    OWNER,
    alloc2Posted.entry_id,
    'smoke reversal of the allocation',
  );
  check('reversal produced a linked entry', Boolean(reversed.reversal_entry_id));

  const original = await db.get(`select status from journal_entries where id = ?`, [
    alloc2Posted.entry_id,
  ]);
  check('original entry is marked reversed', original?.status === 'reversed', original?.status);

  const reversalLink = await db.get(
    `select reversal_of, entry_kind from journal_entries where id = ?`,
    [reversed.reversal_entry_id],
  );
  check(
    'reversal is linked to its original',
    reversalLink?.reversal_of === alloc2Posted.entry_id && reversalLink?.entry_kind === 'reversal',
    `${reversalLink?.entry_kind} -> ${reversalLink?.reversal_of}`,
  );

  // The reversed allocation must drop out of the derived balance, and the
  // invoice must become outstanding again — which reinstates its reminder.
  const afterReversal = await deriveInvoiceState(db, 'inv_smoke');
  check(
    'reversing the allocation restored the invoice balance',
    afterReversal.balance_cents === 58000,
    `${afterReversal.balance_cents}`,
  );

  const reinstated = await db.get(
    `select status from reminders where id = 'rem_smoke'`,
  );
  check(
    'reversing the settlement reinstated the reminder',
    reinstated?.status === 'scheduled',
    `${reinstated?.status}`,
  );

  // A refusal path: reversing the invoice issuance now must still be refused,
  // because the payment allocation is active again.
  let refusedIssuanceReversal = false;
  try {
    await reverseLedgerEntry(db, OWNER, issuePosted.entry_id, 'should be refused');
  } catch {
    refusedIssuanceReversal = true;
  }
  check(
    'reversing an issuance with active allocations is refused',
    refusedIssuanceReversal,
  );

  // And a reversal cannot itself be reversed.
  let refusedDoubleReversal = false;
  try {
    await reverseLedgerEntry(db, OWNER, reversed.reversal_entry_id, 'no');
  } catch {
    refusedDoubleReversal = true;
  }
  check('a reversal cannot be reversed', refusedDoubleReversal);

  // ── Ordering ────────────────────────────────────────────────────────
  console.log('\nOrdering');

  const ordered = await db.all(
    `select id from journal_entries where seller_id = ? order by id`,
    [SELLER],
  );
  const ids = ordered.map((r) => r.id);
  check(
    'ordering by id is stable and equals sorted order',
    JSON.stringify(ids) === JSON.stringify([...ids].sort()),
    `${ids.length} entries`,
  );

  // ── Placing an invoice (createInvoice) ──────────────────────────────
  console.log('\nPlacing an invoice through the service');

  const { createInvoice } = await import(
    join(serverRoot, 'dist', 'services', 'invoices.js')
  );

  const placed = await createInvoice(db, AGENT, {
    seller_id: SELLER,
    customer_name: 'Placed Customer',
    number: 'INV-PLACED-1',
    issue_date: '2026-09-05',
    due_date: '2026-10-05',
    subtotal_cents: 200000,
    tax_cents: 16000,
  });
  check(
    'createInvoice writes the document with the derived total',
    placed.total_cents === 216000 && placed.balance_cents === 216000,
    `total=${placed.total_cents} balance=${placed.balance_cents}`,
  );
  check('placed invoice starts open', placed.status === 'open', placed.status);

  const placedReminders = await db.all(
    `select status from reminders where invoice_id = ?`,
    [placed.id],
  );
  check(
    'reminder ladder was scheduled at creation',
    placedReminders.length === 3 &&
      placedReminders.every((r) => r.status === 'scheduled'),
    `${placedReminders.length} reminders`,
  );

  // Creating the document must not touch the ledger.
  const entriesBeforeIssue = await db.get(
    `select count(*)::int as n from journal_entries where seller_id = ?`,
    [SELLER],
  );
  const issuePlaced = await proposeLedgerUpdate(db, AGENT, {
    kind: 'issue_invoice',
    seller_id: SELLER,
    invoice_id: placed.id,
  });
  await approveLedgerUpdate(db, APPROVER, issuePlaced.id, { reason: 'smoke' });
  await postLedgerUpdate(db, APPROVER, issuePlaced.id);

  const entriesAfterIssue = await db.get(
    `select count(*)::int as n from journal_entries where seller_id = ?`,
    [SELLER],
  );
  check(
    'posting the receivable added exactly one entry',
    Number(entriesAfterIssue?.n) === Number(entriesBeforeIssue?.n) + 1,
    `${entriesBeforeIssue?.n} -> ${entriesAfterIssue?.n}`,
  );

  const placedDerived = await deriveInvoiceState(db, placed.id);
  check(
    'placed invoice is outstanding after issuance',
    placedDerived.balance_cents === 216000 && placedDerived.status === 'open',
    `${placedDerived.balance_cents} / ${placedDerived.status}`,
  );

  // Duplicate numbers are refused per seller.
  let dupRefused = false;
  try {
    await createInvoice(db, AGENT, {
      seller_id: SELLER,
      customer_name: 'Dup',
      number: 'INV-PLACED-1',
      issue_date: '2026-09-05',
      due_date: '2026-10-05',
      subtotal_cents: 1000,
    });
  } catch {
    dupRefused = true;
  }
  check('duplicate invoice number is refused', dupRefused);

  // ── Reconciliation ──────────────────────────────────────────────────
  console.log('\nReconciliation');

  const { summary } = await reconcileSeller(db, SELLER);
  check('trial balance is zero', summary.trial_balanced, `${summary.trial_balance_cents}`);
  check('no drift after the full cycle', summary.drifted_count === 0, `${summary.drifted_count}`);
} catch (err) {
  failed++;
  console.log(`\n  \u2717 uncaught error: ${err?.stack ?? err}`);
} finally {
  try {
    await db.close();
  } catch {
    /* closing is best-effort here */
  }
  await server.stop();
  await pglite.close();
}

console.log('\n===================================================');
console.log(`${passed} passed, ${failed} failed`);
console.log('===================================================\n');

process.exit(failed === 0 ? 0 : 1);
