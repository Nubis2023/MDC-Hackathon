/**
 * Synthetic data seed.
 *
 * Creates two sellers with deliberately different configurations so the
 * multi-tenant controls are visible in the UI:
 *
 *   seller_northwind  — three members (owner, approver, bookkeeper) plus an
 *                       agent. Authoritative system: local.
 *   seller_acme       — a different owner entirely, so an actor from one
 *                       seller gets a 403 on the other. Authoritative system:
 *                       external, to demonstrate provisional postings and
 *                       pending external sync.
 *
 * It then runs a realistic invoice-to-payment workflow through the real
 * service layer — not by inserting rows directly — so the seeded database is
 * evidence that the posting pipeline works end to end.
 *
 * Idempotent: re-running drops and recreates the sample data.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_DB_PATH, describeDatabase, openDatabaseFromEnv, openDb, type SqlDb } from './db';
import type { Actor } from './domain/types';
import { MAPPING_KEYS } from './domain/types';
import { createAdjustment, approveAdjustment } from './services/adjustments';
import { createAutoPostRule } from './services/auto-post';
import {
  postLedgerUpdate,
  proposeLedgerUpdate,
  approveLedgerUpdate,
} from './services/ledger';
import type { OperationInput } from './services/plan';
import { scheduleRemindersForInvoice } from './services/reminders';

// ─────────────────────────────── fixtures ───────────────────────────────

const SELLERS = [
  {
    id: 'seller_northwind',
    name: 'Northwind Trading Co.',
    currency: 'USD',
    authoritative_system: 'local' as const,
  },
  {
    id: 'seller_acme',
    name: 'Acme Fabrication LLC',
    currency: 'USD',
    authoritative_system: 'external' as const,
  },
];

const USERS: Actor[] = [
  { id: 'user_owner_1', name: 'Dana Owner', kind: 'human' },
  { id: 'user_approver_1', name: 'Priya Approver', kind: 'human' },
  { id: 'user_bookkeeper_1', name: 'Sam Bookkeeper', kind: 'human' },
  { id: 'user_owner_2', name: 'Alex Owner (Acme)', kind: 'human' },
  { id: 'agent_recon_1', name: 'Reconciliation Agent', kind: 'agent' },
];

const MEMBERSHIPS: Array<{
  seller_id: string;
  user_id: string;
  role: 'owner' | 'approver' | 'bookkeeper' | 'viewer';
}> = [
  { seller_id: 'seller_northwind', user_id: 'user_owner_1', role: 'owner' },
  { seller_id: 'seller_northwind', user_id: 'user_approver_1', role: 'approver' },
  { seller_id: 'seller_northwind', user_id: 'user_bookkeeper_1', role: 'bookkeeper' },
  { seller_id: 'seller_northwind', user_id: 'agent_recon_1', role: 'bookkeeper' },
  { seller_id: 'seller_acme', user_id: 'user_owner_2', role: 'owner' },
  { seller_id: 'seller_acme', user_id: 'agent_recon_1', role: 'bookkeeper' },
];

/** Chart of accounts, per seller. */
const ACCOUNTS: Array<{
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}> = [
  { id: 'acct_cash', code: '1000', name: 'Cash at Bank', type: 'asset' },
  { id: 'acct_unapplied', code: '1010', name: 'Unapplied Customer Cash', type: 'liability' },
  { id: 'acct_ar', code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { id: 'acct_tax', code: '2200', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'acct_revenue', code: '4000', name: 'Sales Revenue', type: 'revenue' },
  { id: 'acct_credit_note', code: '4100', name: 'Sales Returns and Credits', type: 'revenue' },
  { id: 'acct_fee', code: '6100', name: 'Payment Processing Fees', type: 'expense' },
  { id: 'acct_refund', code: '6200', name: 'Customer Refunds', type: 'expense' },
  { id: 'acct_adjustment', code: '6300', name: 'Ledger Adjustments', type: 'expense' },
];

/** mapping_key + side -> account. This is what the entry builder reads. */
const MAPPINGS: Array<{
  mapping_key: string;
  side: 'debit' | 'credit';
  account_id: string;
}> = [
  { mapping_key: MAPPING_KEYS.CASH, side: 'debit', account_id: 'acct_cash' },
  { mapping_key: MAPPING_KEYS.CASH, side: 'credit', account_id: 'acct_cash' },
  {
    mapping_key: MAPPING_KEYS.UNAPPLIED_CASH,
    side: 'debit',
    account_id: 'acct_unapplied',
  },
  {
    mapping_key: MAPPING_KEYS.UNAPPLIED_CASH,
    side: 'credit',
    account_id: 'acct_unapplied',
  },
  { mapping_key: MAPPING_KEYS.AR, side: 'debit', account_id: 'acct_ar' },
  { mapping_key: MAPPING_KEYS.AR, side: 'credit', account_id: 'acct_ar' },
  { mapping_key: MAPPING_KEYS.REVENUE, side: 'credit', account_id: 'acct_revenue' },
  { mapping_key: MAPPING_KEYS.REVENUE, side: 'debit', account_id: 'acct_revenue' },
  { mapping_key: MAPPING_KEYS.TAX_PAYABLE, side: 'credit', account_id: 'acct_tax' },
  { mapping_key: MAPPING_KEYS.TAX_PAYABLE, side: 'debit', account_id: 'acct_tax' },
  {
    mapping_key: MAPPING_KEYS.CREDIT_NOTE,
    side: 'debit',
    account_id: 'acct_credit_note',
  },
  {
    mapping_key: MAPPING_KEYS.CREDIT_NOTE,
    side: 'credit',
    account_id: 'acct_credit_note',
  },
  { mapping_key: MAPPING_KEYS.FEE_EXPENSE, side: 'debit', account_id: 'acct_fee' },
  { mapping_key: MAPPING_KEYS.FEE_EXPENSE, side: 'credit', account_id: 'acct_fee' },
  { mapping_key: MAPPING_KEYS.REFUND, side: 'debit', account_id: 'acct_refund' },
  { mapping_key: MAPPING_KEYS.REFUND, side: 'credit', account_id: 'acct_refund' },
  {
    mapping_key: MAPPING_KEYS.ADJUSTMENT,
    side: 'debit',
    account_id: 'acct_adjustment',
  },
  {
    mapping_key: MAPPING_KEYS.ADJUSTMENT,
    side: 'credit',
    account_id: 'acct_adjustment',
  },
];

interface SeedInvoice {
  id: string;
  number: string;
  customer_name: string;
  issue_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  /** How much to settle via a payment, in cents. 0 = leave outstanding. */
  settle_cents: number;
  reference: string;
  /** Apply a credit note of this size after settling. */
  credit_note_cents?: number;
  /** Record a processor fee against the payment. */
  fee_cents?: number;
  /** Refund this much of the payment back. */
  refund_cents?: number;
}

const NORTHWIND_INVOICES: SeedInvoice[] = [
  {
    id: 'inv_nw_1001',
    number: 'INV-1001',
    customer_name: 'Harbor Logistics',
    issue_date: '2026-08-01',
    due_date: '2026-08-31',
    subtotal_cents: 1250000,
    tax_cents: 100000,
    settle_cents: 1350000,
    reference: 'WIRE-88121',
    fee_cents: 2700,
  },
  {
    id: 'inv_nw_1002',
    number: 'INV-1002',
    customer_name: 'Cedar Point Retail',
    issue_date: '2026-08-05',
    due_date: '2026-09-04',
    subtotal_cents: 430000,
    tax_cents: 34400,
    settle_cents: 200000,
    reference: 'ACH-55210',
    credit_note_cents: 15000,
  },
  {
    id: 'inv_nw_1003',
    number: 'INV-1003',
    customer_name: 'Vantage Studios',
    issue_date: '2026-08-12',
    due_date: '2026-09-11',
    subtotal_cents: 89000,
    tax_cents: 7120,
    settle_cents: 96120,
    reference: 'CARD-31007',
    refund_cents: 20000,
  },
  {
    id: 'inv_nw_1004',
    number: 'INV-1004',
    customer_name: 'Blue Ridge Catering',
    issue_date: '2026-08-20',
    due_date: '2026-09-19',
    subtotal_cents: 250000,
    tax_cents: 20000,
    settle_cents: 0,
    reference: '',
  },
];

const ACME_INVOICES: SeedInvoice[] = [
  {
    id: 'inv_acme_2001',
    number: 'ACME-2001',
    customer_name: 'Ironworks Supply',
    issue_date: '2026-08-03',
    due_date: '2026-09-02',
    subtotal_cents: 540000,
    tax_cents: 43200,
    settle_cents: 583200,
    reference: 'WIRE-99001',
  },
];

// ──────────────────────────────── seeding ───────────────────────────────

/** Deterministic actor lookup so postings are attributed correctly. */
const OWNER: Actor = USERS[0]!;
const APPROVER: Actor = USERS[1]!;
const BOOKKEEPER: Actor = USERS[2]!;
const ACME_OWNER: Actor = USERS[3]!;
const AGENT: Actor = USERS[4]!;

/** Resolve the payment a posting created, by its unique reference. */
async function requirePaymentId(db: SqlDb, sellerId: string, reference: string): Promise<string>{
  const row = await db.get(
      `SELECT id FROM payments WHERE seller_id = ? AND reference = ?
        ORDER BY id DESC LIMIT 1`, [sellerId, reference]) as { id: string } | undefined;
  if (!row) {
    throw new Error(`seed: no payment found for seller ${sellerId} ref ${reference}`);
  }
  return row.id;
}

async function wipe(db: SqlDb): Promise<void>{
  // Order matters only for readability — every FK is ON DELETE CASCADE from
  // sellers, so deleting sellers clears the financial data.
  await db.exec(`
    DELETE FROM external_sync_attempts;
    DELETE FROM audit_events;
    DELETE FROM ledger_proposals;
    DELETE FROM journal_lines;
    DELETE FROM journal_entries;
    DELETE FROM reminders;
    DELETE FROM refunds;
    DELETE FROM fees;
    DELETE FROM credit_notes;
    DELETE FROM payment_allocations;
    DELETE FROM payments;
    DELETE FROM adjustments;
    DELETE FROM invoices;
    DELETE FROM auto_post_rules;
    DELETE FROM account_mappings;
    DELETE FROM gl_accounts;
    DELETE FROM seller_memberships;
    DELETE FROM users;
    DELETE FROM sellers;
  `);
}

async function insertBaseData(db: SqlDb): Promise<void> {
  for (const s of SELLERS) {
    await db.run(
      `INSERT INTO sellers (id, name, currency, authoritative_system) VALUES (?, ?, ?, ?)`,
      [s.id, s.name, s.currency, s.authoritative_system],
    );
  }

  for (const u of USERS) {
    await db.run(`INSERT INTO users (id, name, kind) VALUES (?, ?, ?)`, [
      u.id,
      u.name,
      u.kind,
    ]);
  }

  for (const m of MEMBERSHIPS) {
    await db.run(
      `INSERT INTO seller_memberships (seller_id, user_id, role) VALUES (?, ?, ?)`,
      [m.seller_id, m.user_id, m.role],
    );
  }

  for (const seller of SELLERS) {
    for (const a of ACCOUNTS) {
      // Account ids are namespaced per seller so the composite key is unique.
      await db.run(
        `INSERT INTO gl_accounts (id, seller_id, code, name, type) VALUES (?, ?, ?, ?, ?)`,
        [`${seller.id}__${a.id}`, seller.id, a.code, a.name, a.type],
      );
    }
    for (const m of MAPPINGS) {
      await db.run(
        `INSERT INTO account_mappings (seller_id, mapping_key, side, account_id)
         VALUES (?, ?, ?, ?)`,
        [seller.id, m.mapping_key, m.side, `${seller.id}__${m.account_id}`],
      );
    }
  }
}

async function insertInvoice(db: SqlDb, sellerId: string, inv: SeedInvoice): Promise<void>{
  const total = inv.subtotal_cents + inv.tax_cents;
  await db.run(
    `INSERT INTO invoices
       (id, seller_id, customer_name, number, issue_date, due_date, currency,
        subtotal_cents, tax_cents, total_cents, balance_cents, status, version)
     VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, 'open', 1)`, [inv.id, sellerId, inv.customer_name, inv.number, inv.issue_date, inv.due_date, inv.subtotal_cents, inv.tax_cents, total, total]);
  const invoice = await db.get(`SELECT * FROM invoices WHERE id = ?`, [inv.id]) as Parameters<typeof scheduleRemindersForInvoice>[1];
  await scheduleRemindersForInvoice(db, invoice);
}

/**
 * Run one operation through the real pipeline: propose → approve → post.
 *
 * Deliberately not inserting journal rows directly. The seeded ledger is
 * therefore exactly what the service produces, including entry numbering,
 * audit events and reminder suppression.
 */
async function runWorkflow(
  db: SqlDb,
  proposer: Actor,
  approver: Actor,
  op: OperationInput,
): Promise<string>{
  const proposal = await proposeLedgerUpdate(db, proposer, op);
  if (proposal.proposed_by !== approver.id) {
    await approveLedgerUpdate(db, approver, proposal.id, { reason: 'seeded workflow approval' });
  }
  const result = await postLedgerUpdate(db, approver, proposal.id);
  return result.entry_id;
}

async function seedNorthwind(db: SqlDb): Promise<void>{
  const sellerId = 'seller_northwind';

  for (const inv of NORTHWIND_INVOICES) {
    await insertInvoice(db, sellerId, inv);

    // 1. Issue the invoice: DR AR / CR revenue + tax.
    await runWorkflow(db, BOOKKEEPER, APPROVER, {
      kind: 'issue_invoice',
      seller_id: sellerId,
      invoice_id: inv.id,
    });

    // 2. Record the confirmed payment: DR cash / CR unapplied cash.
    if (inv.settle_cents > 0) {
      const paymentProposal = await proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: inv.settle_cents,
        received_at: `${inv.issue_date}T10:00:00.000Z`,
        reference: inv.reference,
        payer_name: inv.customer_name,
      });
      await approveLedgerUpdate(db, APPROVER, paymentProposal.id, {
        reason: 'seeded workflow approval',
      });
      await postLedgerUpdate(db, APPROVER, paymentProposal.id);
      const paymentId = await requirePaymentId(db, sellerId, inv.reference);

      // 3. Allocate the payment to the invoice.
      await runWorkflow(db, AGENT, APPROVER, {
        kind: 'allocate_payment',
        seller_id: sellerId,
        payment_id: paymentId,
        invoice_id: inv.id,
        amount_cents: inv.settle_cents,
      });

      // 4. Processor fee against the payment.
      if (inv.fee_cents) {
        await runWorkflow(db, BOOKKEEPER, APPROVER, {
          kind: 'record_fee',
          seller_id: sellerId,
          payment_id: paymentId,
          amount_cents: inv.fee_cents,
          description: 'Card processing fee',
        });
      }

      // 5. Refund part of the payment, re-opening the invoice balance.
      if (inv.refund_cents) {
        await runWorkflow(db, APPROVER, OWNER, {
          kind: 'record_refund',
          seller_id: sellerId,
          payment_id: paymentId,
          invoice_id: inv.id,
          amount_cents: inv.refund_cents,
          reason: 'Damaged goods return',
        });
      }
    }

    // 6. Credit note against the invoice.
    if (inv.credit_note_cents) {
      await runWorkflow(db, BOOKKEEPER, APPROVER, {
        kind: 'apply_credit_note',
        seller_id: sellerId,
        invoice_id: inv.id,
        amount_cents: inv.credit_note_cents,
        reason: 'Short shipment adjustment',
      });
    }
  }

  // 7. A manual write-off adjustment that requires its own approval.
  const adjustment = await createAdjustment(db, BOOKKEEPER, {
    seller_id: sellerId,
    invoice_id: 'inv_nw_1004',
    amount_cents: 25000,
    direction: 'debit',
    mapping_key: MAPPING_KEYS.ADJUSTMENT,
    memo: 'Goodwill write-off approved by finance',
  });
  await approveAdjustment(db, OWNER, sellerId, adjustment.id);
  await runWorkflow(db, BOOKKEEPER, OWNER, {
    kind: 'post_adjustment',
    seller_id: sellerId,
    adjustment_id: adjustment.id,
  });

  // 8. An exact-match auto-post rule, left DISABLED so the default posture
  //    (approval required) is what the seeded data demonstrates. The rule is
  //    there to show the configuration surface and for the tests to enable.
  await createAutoPostRule(db, {
    id: 'rule_nw_fees',
    seller_id: sellerId,
    name: 'Auto-post processing fees up to $50',
    proposal_kind: 'record_fee',
    match: { description: 'Card processing fee' },
    max_amount_cents: 5000,
    enabled: false,
    created_by: OWNER.id,
  });

  // 9. Record a payment that has NOT yet been applied to any invoice, then
  //    leave the allocation as a PENDING proposal. This is the state the
  //    approval queue is meant to show on first load: the agent has proposed
  //    applying the cash, and a seller user has to approve it. It also puts
  //    real unapplied cash on the books, which the reconciliation view
  //    reports separately from outstanding AR.
  const unappliedProposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
    kind: 'record_payment',
    seller_id: sellerId,
    amount_cents: 50000,
    received_at: '2026-09-15T14:30:00.000Z',
    reference: 'ACH-77310',
    payer_name: 'Blue Ridge Catering',
  });
  await approveLedgerUpdate(db, APPROVER, unappliedProposal.id, {
    reason: 'seeded workflow approval',
  });
  await postLedgerUpdate(db, APPROVER, unappliedProposal.id);
  const unappliedPaymentId = await requirePaymentId(db, sellerId, 'ACH-77310');

  await proposeLedgerUpdate(db, AGENT, {
    kind: 'allocate_payment',
    seller_id: sellerId,
    payment_id: unappliedPaymentId,
    invoice_id: 'inv_nw_1004',
    amount_cents: 50000,
  });
}

async function seedAcme(db: SqlDb): Promise<void>{
  const sellerId = 'seller_acme';
  // The agent proposes and the seller's owner approves — the same separation
  // the northwind workflow uses, and required because one actor may never
  // approve its own proposal.
  for (const inv of ACME_INVOICES) {
    await insertInvoice(db, sellerId, inv);
    await runWorkflow(db, AGENT, ACME_OWNER, {
      kind: 'issue_invoice',
      seller_id: sellerId,
      invoice_id: inv.id,
    });
    if (inv.settle_cents > 0) {
      const paymentProposal = await proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: inv.settle_cents,
        received_at: `${inv.issue_date}T09:30:00.000Z`,
        reference: inv.reference,
        payer_name: inv.customer_name,
      });
      await approveLedgerUpdate(db, ACME_OWNER, paymentProposal.id, {
        reason: 'seeded workflow approval',
      });
      await postLedgerUpdate(db, ACME_OWNER, paymentProposal.id);
      const paymentId = await requirePaymentId(db, sellerId, inv.reference);
      await runWorkflow(db, AGENT, ACME_OWNER, {
        kind: 'allocate_payment',
        seller_id: sellerId,
        payment_id: paymentId,
        invoice_id: inv.id,
        amount_cents: inv.settle_cents,
      });
    }
  }
}

export async function seed(db: SqlDb): Promise<void> {
  // One transaction for the whole seed, and every statement inside goes
  // through `tx`. Using `db` here would run outside the transaction on a
  // pooled driver — committing independently, and deadlocking when the pool
  // has a single connection held by this transaction.
  await db.transaction(async (tx) => {
    await wipe(tx);
    await insertBaseData(tx);
    await seedNorthwind(tx);
    await seedAcme(tx);
  });
}

/**
 * Seed a database.
 *
 * Uses the environment-selected backend, so the same script seeds a local
 * SQLite file or a Supabase project depending on SUPABASE_DB_URL. The SQLite
 * path creates its directory first; Postgres is remote and needs no setup.
 */
export async function seedToEnv(): Promise<void> {
  const db = openDatabaseFromEnv();
  try {
    await seed(db);
    const counts = {
      invoices: (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices`))!.n,
      payments: (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments`))!.n,
      journal_entries: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)
      )!.n,
      proposals: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_proposals`)
      )!.n,
      audit_events: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events`)
      )!.n,
    };
    console.log(`seeded ${describeDatabase(db)}`);
    console.table(counts);
  } finally {
    await db.close();
  }
}

/** Seed a specific SQLite file. Kept for tests and local scripting. */
export async function seedToFile(file: string = DEFAULT_DB_PATH): Promise<void> {
  // The database directory is not tracked by git, so it may not exist on a
  // fresh clone. Create it rather than failing on open.
  mkdirSync(dirname(file), { recursive: true });
  const db = openDb({ filename: file });
  try {
    await seed(db);
    const counts = {
      invoices: (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices`))!.n,
      payments: (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments`))!.n,
      journal_entries: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)
      )!.n,
      proposals: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_proposals`)
      )!.n,
      audit_events: (
        await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events`)
      )!.n,
    };
    console.log(`seeded ${file}`);
    console.table(counts);
  } finally {
    await db.close();
  }
}

/**
 * Entry point. Wrapped in main() rather than using top-level await, because
 * the server builds as CommonJS where top-level await is unavailable.
 */
async function main(): Promise<void> {
  const { loadEnv } = require('./env') as typeof import('./env');
  loadEnv();
  await seedToEnv();
}

if (require.main === module) {
  void main();
}
