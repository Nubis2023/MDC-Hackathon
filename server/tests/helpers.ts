/**
 * Shared test fixtures.
 *
 * Every test gets a fresh in-memory database with the minimum configuration
 * needed to post: one seller, four actors with different roles, a chart of
 * accounts and the full set of account mappings.
 */

import { createTestDb, type Db } from '../src/db';
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
  db: Db;
  sellerId: string;
  invoiceId: string;
  /** A second invoice on the same seller, for multi-invoice scenarios. */
  otherInvoiceId: string;
}

export function makeTestDb(
  options: { authoritativeSystem?: 'local' | 'external' } = {},
): TestContext {
  const db = createTestDb();

  db.prepare(
    `INSERT INTO sellers (id, name, currency, authoritative_system) VALUES (?, ?, 'USD', ?)`,
  ).run(SELLER, 'Test Seller', options.authoritativeSystem ?? 'local');

  db.prepare(
    `INSERT INTO sellers (id, name, currency, authoritative_system) VALUES (?, ?, 'USD', 'local')`,
  ).run(OTHER_SELLER, 'Other Seller');

  const insUser = db.prepare(`INSERT INTO users (id, name, kind) VALUES (?, ?, ?)`);
  for (const actor of [OWNER, APPROVER, BOOKKEEPER, OUTSIDER, AGENT, VIEWER]) {
    insUser.run(actor.id, actor.name, actor.kind);
  }

  const insMembership = db.prepare(
    `INSERT INTO seller_memberships (seller_id, user_id, role) VALUES (?, ?, ?)`,
  );
  insMembership.run(SELLER, OWNER.id, 'owner');
  insMembership.run(SELLER, APPROVER.id, 'approver');
  insMembership.run(SELLER, BOOKKEEPER.id, 'bookkeeper');
  insMembership.run(SELLER, AGENT.id, 'bookkeeper');
  insMembership.run(SELLER, VIEWER.id, 'viewer');
  // OUTSIDER deliberately gets membership of the other seller only.
  insMembership.run(OTHER_SELLER, OUTSIDER.id, 'owner');

  const insAccount = db.prepare(
    `INSERT INTO gl_accounts (id, seller_id, code, name, type) VALUES (?, ?, ?, ?, ?)`,
  );
  const insMapping = db.prepare(
    `INSERT INTO account_mappings (seller_id, mapping_key, side, account_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const sellerId of [SELLER, OTHER_SELLER]) {
    for (const a of ACCOUNTS) {
      insAccount.run(`${sellerId}__${a.id}`, sellerId, a.code, a.name, a.type);
    }
    for (const [mappingKey, target] of Object.entries(MAPPING_TARGETS)) {
      insMapping.run(sellerId, mappingKey, 'debit', `${sellerId}__${target}`);
      insMapping.run(sellerId, mappingKey, 'credit', `${sellerId}__${target}`);
    }
  }

  const invoiceId = insertTestInvoice(db, SELLER, {
    id: 'inv_1',
    number: 'INV-1',
    totalCents: 100000,
    taxCents: 0,
  });
  const otherInvoiceId = insertTestInvoice(db, SELLER, {
    id: 'inv_2',
    number: 'INV-2',
    totalCents: 50000,
    taxCents: 0,
  });

  return { db, sellerId: SELLER, invoiceId, otherInvoiceId };
}

export function insertTestInvoice(
  db: Db,
  sellerId: string,
  opts: {
    id: string;
    number: string;
    totalCents: number;
    taxCents?: number;
    dueDate?: string;
    customerName?: string;
  },
): string {
  const tax = opts.taxCents ?? 0;
  const subtotal = opts.totalCents - tax;
  db.prepare(
    `INSERT INTO invoices
       (id, seller_id, customer_name, number, issue_date, due_date, currency,
        subtotal_cents, tax_cents, total_cents, balance_cents, status, version)
     VALUES (?, ?, ?, ?, '2026-08-01', ?, 'USD', ?, ?, ?, ?, 'open', 1)`,
  ).run(
    opts.id,
    sellerId,
    opts.customerName ?? 'Test Customer',
    opts.number,
    opts.dueDate ?? '2026-09-01',
    subtotal,
    tax,
    opts.totalCents,
    opts.totalCents,
  );

  const invoice = db
    .prepare(`SELECT * FROM invoices WHERE id = ?`)
    .get(opts.id) as Parameters<typeof scheduleRemindersForInvoice>[1];
  scheduleRemindersForInvoice(db, invoice);
  return opts.id;
}

/** Issue an invoice to the ledger and return the entry id. */
export function issueInvoice(
  db: Db,
  sellerId: string,
  invoiceId: string,
  proposer: Actor = BOOKKEEPER,
  approver: Actor = APPROVER,
): string {
  const proposal = proposeLedgerUpdate(db, proposer, {
    kind: 'issue_invoice',
    seller_id: sellerId,
    invoice_id: invoiceId,
  });
  approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  return postLedgerUpdate(db, approver, proposal.id).entry_id;
}

/** Record a confirmed payment and return its id. */
export function recordPayment(
  db: Db,
  sellerId: string,
  amountCents: number,
  reference: string,
  proposer: Actor = AGENT,
  approver: Actor = APPROVER,
): string {
  const proposal = proposeLedgerUpdate(db, proposer, {
    kind: 'record_payment',
    seller_id: sellerId,
    amount_cents: amountCents,
    received_at: '2026-09-01T12:00:00.000Z',
    reference,
    payer_name: 'Test Customer',
  });
  approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  postLedgerUpdate(db, approver, proposal.id);
  const row = db
    .prepare(`SELECT id FROM payments WHERE seller_id = ? AND reference = ?`)
    .get(sellerId, reference) as { id: string };
  return row.id;
}

/** Post an allocation through the full pipeline. */
export function allocatePayment(
  db: Db,
  sellerId: string,
  paymentId: string,
  invoiceId: string,
  amountCents: number,
  proposer: Actor = AGENT,
  approver: Actor = APPROVER,
): string {
  const proposal = proposeLedgerUpdate(db, proposer, {
    kind: 'allocate_payment',
    seller_id: sellerId,
    payment_id: paymentId,
    invoice_id: invoiceId,
    amount_cents: amountCents,
  });
  approveLedgerUpdate(db, approver, proposal.id, { reason: 'test' });
  return postLedgerUpdate(db, approver, proposal.id).entry_id;
}
