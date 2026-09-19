/**
 * Shared test fixtures.
 *
 * Every test gets a fresh in-memory database with the minimum configuration
 * needed to post: one seller, four actors with different roles, a chart of
 * accounts and the full set of account mappings.
 */

import { createTestDb as createSqliteTestDb, openPostgres, type SqlDb } from '../src/db';
import type { Actor } from '../src/domain/types';
import { MAPPING_KEYS } from '../src/domain/types';
import { scheduleRemindersForInvoice } from '../src/services/reminders';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
} from '../src/services/ledger';

export const SELLER = 'seller_test';
export const OTHER_SELLER = 'seller_other';

/**
 * When TEST_POSTGRES_URL is set, the suite runs against Postgres instead of
 * in-memory SQLite. That is how the dialect port is verified: the same tests,
 * unchanged, exercise the real Postgres driver rather than a mock.
 *
 * A single pool is reused for the whole process and truncated between tests,
 * because opening a connection per test would be far slower and, under
 * vitest's forked pool, would exhaust connections.
 */
let pgPool: SqlDb | null = null;

async function truncateAll(db: SqlDb): Promise<void> {
  const tables = await db.all<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (tables.length === 0) return;
  // One statement with CASCADE: the tables are densely foreign-keyed, and
  // truncating them individually would fail on dependency order.
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.exec(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * A clean database for one test case.
 *
 * SQLite: a brand-new in-memory database, so isolation is free.
 * Postgres: the shared pool, emptied first.
 */
async function freshTestDb(): Promise<SqlDb> {
  const url = process.env.TEST_POSTGRES_URL;
  if (!url) return createSqliteTestDb();

  if (!pgPool) {
    pgPool = openPostgres({
      url,
      ssl: (process.env.TEST_POSTGRES_SSL ?? 'disable') as
        | 'require'
        | 'no-verify'
        | 'disable',
      // One connection per process. The suite runs with file parallelism
      // disabled when targeting Postgres (see vitest.config.ts), so a single
      // connection is enough and keeps clear of the socket server's limits.
      max: 1,
    });
  }
  await truncateAll(pgPool);
  return pgPool;
}

/** Close the shared Postgres pool, if one was opened. */
export async function closeTestDb(): Promise<void> {
  if (pgPool) {
    await pgPool.close();
    pgPool = null;
  }
}

export const OWNER: Actor = { id: 'u_owner', name: 'Olive Owner', kind: 'human' };
export const APPROVER: Actor = {
  id: 'u_approver',
  name: 'Priya Approver',
  kind: 'human',
};
export const BOOKKEEPER: Actor = {
  id: 'u_bookkeeper',
  name: 'Sam Bookkeeper',
  kind: 'human',
};
export const OUTSIDER: Actor = {
  id: 'u_outsider',
  name: 'Oscar Outsider',
  kind: 'human',
};
export const AGENT: Actor = {
  id: 'u_agent',
  name: 'Recon Agent',
  kind: 'agent',
};
export const VIEWER: Actor = { id: 'u_viewer', name: 'Vic Viewer', kind: 'human' };

const ACCOUNTS = [
  { id: 'cash', code: '1000', name: 'Cash', type: 'asset' },
  { id: 'unapplied', code: '1010', name: 'Unapplied Cash', type: 'liability' },
  { id: 'ar', code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { id: 'tax', code: '2200', name: 'Tax Payable', type: 'liability' },
  { id: 'revenue', code: '4000', name: 'Revenue', type: 'revenue' },
  { id: 'credit_note', code: '4100', name: 'Credits', type: 'revenue' },
  { id: 'fee', code: '6100', name: 'Fees', type: 'expense' },
  { id: 'refund', code: '6200', name: 'Refunds', type: 'expense' },
  { id: 'adjustment', code: '6300', name: 'Adjustments', type: 'expense' },
] as const;

/** mapping_key -> the account it resolves to, for both sides. */
const MAPPING_TARGETS: Record<string, string> = {
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

export interface TestContext {
  db: SqlDb;
  sellerId: string;
  invoiceId: string;
  /** A second invoice on the same seller, for multi-invoice scenarios. */
  otherInvoiceId: string;
}

export async function makeTestDb(
  options: { authoritativeSystem?: 'local' | 'external' } = {},
): Promise<TestContext> {
  const db = await freshTestDb();

  await db.run(
    `INSERT INTO sellers (id, name, currency, authoritative_system) VALUES (?, ?, 'USD', ?)`,
    [SELLER, 'Test Seller', options.authoritativeSystem ?? 'local'],
  );

  await db.run(
    `INSERT INTO sellers (id, name, currency, authoritative_system) VALUES (?, ?, 'USD', 'local')`,
    [OTHER_SELLER, 'Other Seller'],
  );

  // Statements are issued directly rather than through reused prepared
  // handles: the async interface has no prepare(), and inside one call this is
  // equivalent. The fixture is not on a hot path.
  for (const actor of [OWNER, APPROVER, BOOKKEEPER, OUTSIDER, AGENT, VIEWER]) {
    await db.run(`INSERT INTO users (id, name, kind) VALUES (?, ?, ?)`, [
      actor.id,
      actor.name,
      actor.kind,
    ]);
  }

  const memberships: Array<[string, string, string]> = [
    [SELLER, OWNER.id, 'owner'],
    [SELLER, APPROVER.id, 'approver'],
    [SELLER, BOOKKEEPER.id, 'bookkeeper'],
    [SELLER, AGENT.id, 'bookkeeper'],
    [SELLER, VIEWER.id, 'viewer'],
    // OUTSIDER deliberately gets membership of the other seller only.
    [OTHER_SELLER, OUTSIDER.id, 'owner'],
  ];
  for (const [sellerId, userId, role] of memberships) {
    await db.run(
      `INSERT INTO seller_memberships (seller_id, user_id, role) VALUES (?, ?, ?)`,
      [sellerId, userId, role],
    );
  }

  for (const sellerId of [SELLER, OTHER_SELLER]) {
    for (const a of ACCOUNTS) {
      await db.run(
        `INSERT INTO gl_accounts (id, seller_id, code, name, type) VALUES (?, ?, ?, ?, ?)`,
        [`${sellerId}__${a.id}`, sellerId, a.code, a.name, a.type],
      );
    }
    for (const [mappingKey, target] of Object.entries(MAPPING_TARGETS)) {
      await db.run(
        `INSERT INTO account_mappings (seller_id, mapping_key, side, account_id)
         VALUES (?, ?, ?, ?)`,
        [sellerId, mappingKey, 'debit', `${sellerId}__${target}`],
      );
      await db.run(
        `INSERT INTO account_mappings (seller_id, mapping_key, side, account_id)
         VALUES (?, ?, ?, ?)`,
        [sellerId, mappingKey, 'credit', `${sellerId}__${target}`],
      );
    }
  }

  const invoiceId = await insertTestInvoice(db, SELLER, {
    id: 'inv_1',
    number: 'INV-1',
    totalCents: 100000,
    taxCents: 0,
  });
  const otherInvoiceId = await insertTestInvoice(db, SELLER, {
    id: 'inv_2',
    number: 'INV-2',
    totalCents: 50000,
    taxCents: 0,
  });

  return { db, sellerId: SELLER, invoiceId, otherInvoiceId };
}

export async function insertTestInvoice(
  db: SqlDb,
  sellerId: string,
  opts: {
    id: string;
    number: string;
    totalCents: number;
    taxCents?: number;
    dueDate?: string;
    customerName?: string;
  },
): Promise<string>{
  const tax = opts.taxCents ?? 0;
  const subtotal = opts.totalCents - tax;
  await db.run(
    `INSERT INTO invoices
       (id, seller_id, customer_name, number, issue_date, due_date, currency,
        subtotal_cents, tax_cents, total_cents, balance_cents, status, version)
     VALUES (?, ?, ?, ?, '2026-08-01', ?, 'USD', ?, ?, ?, ?, 'open', 1)`, [opts.id, sellerId, opts.customerName ?? 'Test Customer', opts.number, opts.dueDate ?? '2026-09-01', subtotal, tax, opts.totalCents, opts.totalCents]);

  const invoice = await db.get(`SELECT * FROM invoices WHERE id = ?`, [opts.id]) as Parameters<typeof scheduleRemindersForInvoice>[1];
  await scheduleRemindersForInvoice(db, invoice);
  return opts.id;
}

/** Issue an invoice to the ledger and return the entry id. */
export async function issueInvoice(
  db: SqlDb,
  sellerId: string,
  invoiceId: string,
  proposer: Actor = BOOKKEEPER,
  approver: Actor = APPROVER,
): Promise<string>{
  const proposal = await proposeLedgerUpdate(db, proposer, {
    kind: 'issue_invoice',
    seller_id: sellerId,
    invoice_id: invoiceId,
  });
  await approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  return (await postLedgerUpdate(db, approver, proposal.id)).entry_id;
}

/** Record a confirmed payment and return its id. */
export async function recordPayment(
  db: SqlDb,
  sellerId: string,
  amountCents: number,
  reference: string,
  proposer: Actor = AGENT,
  approver: Actor = APPROVER,
): Promise<string>{
  const proposal = await proposeLedgerUpdate(db, proposer, {
    kind: 'record_payment',
    seller_id: sellerId,
    amount_cents: amountCents,
    received_at: '2026-09-01T12:00:00.000Z',
    reference,
    payer_name: 'Test Customer',
  });
  await approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  await postLedgerUpdate(db, approver, proposal.id);
  const row = await db.get(`SELECT id FROM payments WHERE seller_id = ? AND reference = ?`, [sellerId, reference]) as { id: string };
  return row.id;
}

/** Post an allocation through the full pipeline. */
export async function allocatePayment(
  db: SqlDb,
  sellerId: string,
  paymentId: string,
  invoiceId: string,
  amountCents: number,
  proposer: Actor = AGENT,
  approver: Actor = APPROVER,
): Promise<string>{
  const proposal = await proposeLedgerUpdate(db, proposer, {
    kind: 'allocate_payment',
    seller_id: sellerId,
    payment_id: paymentId,
    invoice_id: invoiceId,
    amount_cents: amountCents,
  });
  await approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  return (await postLedgerUpdate(db, approver, proposal.id)).entry_id;
}
