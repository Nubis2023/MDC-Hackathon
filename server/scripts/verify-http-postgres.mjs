/**
 * Prove the whole HTTP API runs against Postgres.
 *
 * The smoke test exercises the service layer directly. This goes one level
 * further: it starts a real Postgres (PGlite behind PGLiteSocketServer), boots
 * the actual compiled server (`dist/index.js`) pointed at it via
 * SUPABASE_DB_URL, and drives the HTTP endpoints — so env loading, backend
 * selection, the Express routes and the dialect layer are all verified
 * together, exactly as they would run against Supabase.
 *
 * PGlite is used rather than a live Supabase project because the API tests
 * write data, and doing that against the real project would pollute it with
 * test rows. PGlite IS Postgres, so the dialect behaviour is the same.
 *
 * Run: node server/scripts/verify-http-postgres.mjs   (after `npm run build`)
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const repoRoot = join(serverRoot, '..');

const PG_PORT = 55450;
const API_PORT = 4100;
const BASE = `http://127.0.0.1:${API_PORT}`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** Minimal HTTP helper with the actor header the API expects. */
async function call(
  method,
  path,
  // Must match an id the fixtures created, or every request 401s at the actor
  // resolution middleware before reaching any route.
  { actor = 'u_bookkeeper', body } = {},
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Actor-Id': actor,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

console.log('\nHTTP API against Postgres (end to end)');
console.log('======================================\n');

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
console.log('migration applied');

const pgServer = new PGLiteSocketServer({
  db: pglite,
  port: PG_PORT,
  host: '127.0.0.1',
  maxConnections: 10,
});
await pgServer.start();
console.log(`Postgres listening on 127.0.0.1:${PG_PORT}`);

// ── Boot the real server against Postgres ────────────────────────────
// Pointed at Postgres purely through the environment, which is what proves
// backend selection works: the process must pick the URL up, connect over the
// wire, and report `postgres` at startup. No .env file is involved, and real
// environment variables take precedence over any that exists.
const server = spawn('node', [join(serverRoot, 'dist', 'index.js')], {
  cwd: serverRoot,
  env: {
    ...process.env,
    SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
    SUPABASE_DB_SSL: 'disable',
    PORT: String(API_PORT),
    // PGlite's socket server does not isolate session state across concurrent
    // connections, so a multi-connection pool hits "unnamed prepared statement
    // does not exist". A single connection sidesteps that. Real Postgres —
    // including Supabase — has no such limitation, so this is test-only.
    SUPABASE_DB_POOL_MAX: '1',
  },
});

let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d.toString()));
server.stderr.on('data', (d) => (serverOut += d.toString()));

let exitCode = 0;
try {
  await waitForServer();

  function waitForServer() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 40000;
      const tick = async () => {
        if (serverOut.includes('listening on')) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error(`server did not start:\n${serverOut}`));
        }
        // A health probe is the real signal; the log line just speeds it up.
        try {
          const res = await fetch(`${BASE}/api/health`);
          if (res.ok) return resolve();
        } catch {
          /* not up yet */
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  check(
    'server started against Postgres',
    serverOut.includes('listening on'),
    serverOut.split('\n').find((l) => l.includes('listening on')) ?? serverOut.slice(0, 200),
  );
  check(
    'startup reported the postgres backend',
    /database:\s+postgres/.test(serverOut),
    serverOut.split('\n').find((l) => l.includes('database:')) ?? '(no database line)',
  );

// ── Fixtures via SQL (the API has no seller-creation route) ────────
// Seeded straight into Postgres rather than through the API, because the API
// deliberately has no route for creating sellers or users: those are
// provisioning concerns, not ledger operations.
const SELLER = 'seller_http';
async function seedFixtures() {
  await pglite.exec(`
    insert into sellers (id, name, currency, authoritative_system) values
      ('${SELLER}', 'HTTP Seller', 'USD', 'local'),
      -- A second seller with its own member, so the cross-seller refusal can be
      -- exercised by an actor who is genuinely a member of somewhere — an
      -- unknown actor id would 401 at the middleware and prove nothing about
      -- seller scoping.
      ('seller_other_http', 'Other HTTP Seller', 'USD', 'local');

    insert into users (id, name, kind) values
      ('u_owner', 'Owner', 'human'),
      ('u_approver', 'Approver', 'human'),
      ('u_bookkeeper', 'Bookkeeper', 'human'),
      ('u_agent', 'Agent', 'agent'),
      ('u_outsider', 'Outsider', 'human');

    insert into seller_memberships (seller_id, user_id, role) values
      ('${SELLER}', 'u_owner', 'owner'),
      ('${SELLER}', 'u_approver', 'approver'),
      ('${SELLER}', 'u_bookkeeper', 'bookkeeper'),
      ('${SELLER}', 'u_agent', 'bookkeeper'),
      ('seller_other_http', 'u_outsider', 'owner');
  `);
  for (const [suffix, code, name, type] of [
    ['cash', '1000', 'Cash', 'asset'],
    ['unapplied', '1010', 'Unapplied Cash', 'liability'],
    ['ar', '1100', 'Accounts Receivable', 'asset'],
    ['tax', '2200', 'Tax Payable', 'liability'],
    ['revenue', '4000', 'Revenue', 'revenue'],
    ['credit_note', '4100', 'Credits', 'revenue'],
    ['fee', '6100', 'Fees', 'expense'],
    ['refund', '6200', 'Refunds', 'expense'],
    ['adjustment', '6300', 'Adjustments', 'expense'],
  ]) {
    await pglite.exec(
      `insert into gl_accounts (id, seller_id, code, name, type)
       values ('${SELLER}__${suffix}', '${SELLER}', '${code}', '${name}', '${type}')`,
    );
  }
  const targets = {
    cash: 'cash',
    unapplied_cash: 'unapplied',
    accounts_receivable: 'ar',
    revenue: 'revenue',
    tax_payable: 'tax',
    credit_note: 'credit_note',
    fee_expense: 'fee',
    refund_expense: 'refund',
    adjustment: 'adjustment',
  };
  for (const [key, target] of Object.entries(targets)) {
    for (const side of ['debit', 'credit']) {
      await pglite.exec(
        `insert into account_mappings (seller_id, mapping_key, side, account_id)
         values ('${SELLER}', '${key}', '${side}', '${SELLER}__${target}')`,
      );
    }
  }
}

  // ── Fixtures ───────────────────────────────────────────────────────
  // Provisioned straight into Postgres: the API deliberately has no route for
  // creating sellers or users, since those are provisioning concerns rather
  // than ledger operations.
  await seedFixtures();

  // ── Health and bootstrap ───────────────────────────────────────────
  console.log('\nReads over HTTP');

  const health = await call('GET', '/api/health');
  check('GET /api/health is 200', health.status === 200, JSON.stringify(health.body));

  const boot = await call('GET', '/api/bootstrap');
  check(
    'GET /api/bootstrap returns a seller with a role',
    boot.status === 200 && boot.body?.sellers?.[0]?.role === 'bookkeeper',
    JSON.stringify(boot.body?.sellers?.[0] ?? boot.body).slice(0, 160),
  );
  // ── Place an invoice over HTTP ─────────────────────────────────────
  console.log('\nPlacing an invoice over HTTP');

  const created = await call('POST', `/api/sellers/${SELLER}/invoices`, {
    body: {
      customer_name: 'HTTP Customer',
      number: 'INV-HTTP-1',
      issue_date: '2026-09-01',
      due_date: '2026-10-01',
      subtotal_cents: 125000,
      tax_cents: 10000,
    },
  });
  check(
    'POST invoice returns 201 with the derived total',
    created.status === 201 && created.body?.invoice?.total_cents === 135000,
    `status=${created.status} body=${JSON.stringify(created.body).slice(0, 160)}`,
  );

  const invoiceId = created.body?.invoice?.id;
  check('the response carries a next_operation', Boolean(created.body?.next_operation?.kind));

  // The document exists, but must not be on the ledger yet.
  const journalBefore = await call('GET', `/api/sellers/${SELLER}/journal`);
  check(
    'creating an invoice does not post to the ledger',
    journalBefore.status === 200 && journalBefore.body?.entries?.length === 0,
    `${journalBefore.body?.entries?.length} entries`,
  );

  const reminders = await call('GET', `/api/sellers/${SELLER}/reminders`);
  check(
    'the reminder ladder was scheduled',
    reminders.status === 200 &&
      reminders.body?.reminders?.length === 3 &&
      reminders.body.reminders.every((r) => r.status === 'scheduled'),
    `${reminders.body?.reminders?.length} reminders`,
  );

  // ── Preview, propose, approve, post ────────────────────────────────
  console.log('\nThe approval flow over HTTP');

  const preview = await call('POST', `/api/sellers/${SELLER}/proposals/preview`, {
    body: { operation: { kind: 'issue_invoice', invoice_id: invoiceId } },
  });
  const lines = preview.body?.preview?.lines ?? [];
  check(
    'preview is balanced with the expected debits and credits',
    preview.status === 200 &&
      preview.body.preview.balanced === true &&
      lines.length === 3 &&
      String(lines[0].side) === 'debit' &&
      Number(lines[0].amount_cents) === 135000,
    `balanced=${preview.body?.preview?.balanced} lines=${lines.length}`,
  );

  const proposed = await call('POST', `/api/sellers/${SELLER}/proposals`, {
    body: { operation: { kind: 'issue_invoice', invoice_id: invoiceId } },
  });
  check(
    'proposing returns 201 and awaits approval',
    proposed.status === 201 && proposed.body?.proposal?.status === 'proposed',
    `status=${proposed.status} ${proposed.body?.proposal?.status}`,
  );
  const proposalId = proposed.body?.proposal?.id;

  // The agent must not be able to approve.
  const agentApproval = await call('POST', `/api/proposals/${proposalId}/approve`, {
    actor: 'u_agent',
  });
  check(
    'an agent cannot approve (403)',
    agentApproval.status === 403,
    `status=${agentApproval.status}`,
  );

  const approved = await call('POST', `/api/proposals/${proposalId}/approve`, {
    actor: 'u_approver',
    body: { reason: 'verified over http' },
  });
  check(
    'a human approver succeeds',
    approved.status === 200 && approved.body?.ok === true,
    `status=${approved.status} ${JSON.stringify(approved.body).slice(0, 120)}`,
  );

  const posted = await call('POST', `/api/proposals/${proposalId}/post`, {
    actor: 'u_approver',
  });
  check(
    'posting returns an entry number',
    posted.status === 200 && Number(posted.body?.result?.entry_no) >= 1,
    `status=${posted.status} entry_no=${posted.body?.result?.entry_no}`,
  );

  // ── The ledger now reflects it ─────────────────────────────────────
  console.log('\nLedger state after posting');

  const journalAfter = await call('GET', `/api/sellers/${SELLER}/journal`);
  const entry = journalAfter.body?.entries?.[0];
  check(
    'the journal holds one balanced entry',
    journalAfter.body?.entries?.length === 1 && entry?.balanced === true,
    `${journalAfter.body?.entries?.length} entries, balanced=${entry?.balanced}`,
  );
  check(
    'line amounts arrived as numbers, not strings',
    typeof entry?.lines?.[0]?.amount_cents === 'number',
    `${typeof entry?.lines?.[0]?.amount_cents}`,
  );

  const recon = await call('GET', `/api/sellers/${SELLER}/reconciliation`);
  check(
    'reconciliation reports a balanced trial balance and no drift',
    recon.status === 200 &&
      recon.body?.summary?.trial_balanced === true &&
      recon.body?.summary?.drifted_count === 0,
    `trial=${recon.body?.summary?.trial_balance_cents} drift=${recon.body?.summary?.drifted_count}`,
  );

  const balances = recon.body?.accounts ?? [];
  const ar = balances.find((b) => b.code === '1100');
  const revenue = balances.find((b) => b.code === '4000');
  const tax = balances.find((b) => b.code === '2200');
  check(
    'AR/net/tax are the expected numbers',
    Number(ar?.net_cents) === 135000 &&
      Number(revenue?.net_cents) === -125000 &&
      Number(tax?.net_cents) === -10000,
    `AR=${ar?.net_cents} rev=${revenue?.net_cents} tax=${tax?.net_cents}`,
  );

  // ── Payment, allocation, reminder suppression ──────────────────────
  console.log('\nSettling it, and reminder suppression');

  const payProposed = await call('POST', `/api/sellers/${SELLER}/proposals`, {
    actor: 'u_agent',
    body: {
      operation: {
        kind: 'record_payment',
        amount_cents: 135000,
        received_at: '2026-09-15T10:00:00.000Z',
        reference: 'HTTP-WIRE-1',
        payer_name: 'HTTP Customer',
      },
    },
  });
  const payProposalId = payProposed.body?.proposal?.id;
  await call('POST', `/api/proposals/${payProposalId}/approve`, { actor: 'u_approver' });
  await call('POST', `/api/proposals/${payProposalId}/post`, { actor: 'u_approver' });

  const payments = await call('GET', `/api/sellers/${SELLER}/payments`);
  const paymentId = payments.body?.payments?.[0]?.id;
  check(
    'the payment is recorded with a numeric amount',
    typeof payments.body?.payments?.[0]?.amount_cents === 'number' &&
      payments.body.payments[0].amount_cents === 135000,
    `${payments.body?.payments?.length} payment(s)`,
  );

  const allocProposed = await call('POST', `/api/sellers/${SELLER}/proposals`, {
    actor: 'u_agent',
    body: {
      operation: {
        kind: 'allocate_payment',
        payment_id: paymentId,
        invoice_id: invoiceId,
        amount_cents: 135000,
      },
    },
  });
  const allocId = allocProposed.body?.proposal?.id;
  await call('POST', `/api/proposals/${allocId}/approve`, { actor: 'u_approver' });
  await call('POST', `/api/proposals/${allocId}/post`, { actor: 'u_approver' });

  const remindersAfter = await call('GET', `/api/sellers/${SELLER}/reminders`);
  check(
    'settling the invoice suppressed all three reminders',
    (remindersAfter.body?.reminders ?? []).length === 3 &&
      (remindersAfter.body?.reminders ?? []).every((r) => r.status === 'suppressed'),
    // Requiring exactly three matters: `every()` on an empty array is true, so
    // a broken endpoint returning nothing would otherwise pass this check.
    `${(remindersAfter.body?.reminders ?? []).length} reminders: ` +
      (remindersAfter.body?.reminders ?? []).map((r) => r.status).join(','),
  );
  check(
    'the outstanding list is now empty',
    (remindersAfter.body?.outstanding ?? []).length === 0,
    `${(remindersAfter.body?.outstanding ?? []).length} outstanding`,
  );

  // ── Reversal over HTTP ─────────────────────────────────────────────
  console.log('\nReversal over HTTP');

  const allocEntryId = (journalAfter.body?.entries ?? []).length
    ? (await call('GET', `/api/sellers/${SELLER}/journal`)).body.entries.find(
        (e) => e.source_type === 'allocate_payment',
      )?.id
    : undefined;

  const reversed = await call('POST', `/api/journal/${allocEntryId}/reverse`, {
    actor: 'u_owner',
    body: { reason: 'verified reversal over http' },
  });
  check(
    'reversal succeeds and returns a linked entry',
    reversed.status === 200 && Boolean(reversed.body?.result?.reversal_entry_id),
    JSON.stringify(reversed.body).slice(0, 160),
  );

  const reconAfter = await call('GET', `/api/sellers/${SELLER}/reconciliation`);
  check(
    'reconciliation stays clean after the reversal',
    reconAfter.body?.summary?.trial_balanced === true &&
      reconAfter.body?.summary?.drifted_count === 0,
    `trial=${reconAfter.body?.summary?.trial_balance_cents} drift=${reconAfter.body?.summary?.drifted_count}`,
  );

  // ── Cross-seller isolation over HTTP ───────────────────────────────
  console.log('\nSeller isolation over HTTP');

  const forbidden = await call('GET', `/api/sellers/${SELLER}/invoices`, {
    actor: 'u_outsider',
  });
  check(
    'an actor who belongs to another seller gets 403',
    forbidden.status === 403,
    `status=${forbidden.status} body=${JSON.stringify(forbidden.body).slice(0, 120)}`,
  );

  // And that outsider can still use the API for their own seller, so the
  // refusal above is about seller scoping rather than a broken account.
  const ownSeller = await call('GET', '/api/sellers/seller_other_http/invoices', {
    actor: 'u_outsider',
  });
  check(
    'the same actor can read their own seller',
    ownSeller.status === 200,
    `status=${ownSeller.status}`,
  );

  const badActor = await call('GET', `/api/sellers/${SELLER}/invoices`, {
    actor: 'nobody',
  });
  check(
    'an unknown actor is rejected',
    badActor.status === 401 || badActor.status === 403,
    `status=${badActor.status}`,
  );

  // ── The rowid -> id port: ordering must be stable on Postgres ──────
  console.log('\nOrdering and idempotency on Postgres');

  const entries = await call('GET', `/api/sellers/${SELLER}/journal`);
  const ids = (entries.body?.entries ?? []).map((e) => e.id);
  check(
    'journal ids are unique',
    new Set(ids).size === ids.length,
    `${ids.length} entries`,
  );
  check(
    'entries carry monotonic entry numbers',
    (entries.body?.entries ?? []).every((e, i, arr) => i === 0 || arr[i - 1].entry_no > e.entry_no),
    (entries.body?.entries ?? []).map((e) => e.entry_no).join(','),
  );

  const replay = await call('POST', `/api/proposals/${proposalId}/post`, {
    actor: 'u_approver',
  });
  check(
    're-posting a posted proposal replays instead of duplicating',
    replay.status === 200 && replay.body?.result?.replayed === true,
    `replayed=${replay.body?.result?.replayed}`,
  );

  const afterReplay = await call('GET', `/api/sellers/${SELLER}/journal`);
  check(
    'the replay created no additional entry',
    afterReplay.body?.entries?.length === entries.body?.entries?.length,
    `${afterReplay.body?.entries?.length} vs ${entries.body?.entries?.length}`,
  );
} catch (err) {
  failed++;
  console.log(`\n  \u2717 uncaught: ${err?.stack ?? err}`);
  // The server's own output is the only way to see why it died mid-run.
  console.log(`\n--- server output ---\n${serverOut || '(none)'}\n--- end ---\n`);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (!server.killed) server.kill('SIGKILL');
  await pgServer.stop();
  await pglite.close();
}

console.log('\n======================================');
console.log(`${passed} passed, ${failed} failed`);
console.log('======================================\n');

process.exit(failed === 0 && exitCode === 0 ? 0 : 1);
