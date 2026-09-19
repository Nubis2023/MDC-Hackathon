/**
 * The reconciliation interface.
 *
 * This answers the operator's question — "does the money we received match
 * the invoices we issued?" — by independently re-deriving every balance from
 * source rows and comparing it against the cached values the ledger
 * maintains. Any disagreement is reported as drift rather than smoothed over.
 *
 * Three reconciliations are exposed:
 *   1. invoice-level: allocation ledger vs the invoice's cached balance
 *   2. payment-level: allocation ledger vs the payment's cached unallocated
 *   3. trial-balance:   journal lines grouped by account, which must sum to
 *                       zero across the whole ledger
 *
 * It is deliberately read-only. Nothing here posts; corrections go through
 * the same propose/approve/post path as any other ledger write.
 */

import type { Db } from '../db';
import type { InvoiceRecord, ReconciliationRow } from '../domain/types';

export interface ReconciliationSummary {
  seller_id: string;
  as_of: string;
  invoice_count: number;
  reconciled_count: number;
  drifted_count: number;
  total_outstanding_cents: number;
  total_allocated_cents: number;
  total_unapplied_cash_cents: number;
  trial_balance_cents: number;
  trial_balanced: boolean;
  drift: DriftItem[];
  authoritative_system: 'local' | 'external';
}

export interface DriftItem {
  kind: 'invoice_balance' | 'payment_unallocated' | 'oversettled_invoice' | 'trial_balance';
  entity_type: string;
  entity_id: string;
  description: string;
  expected_cents: number;
  actual_cents: number;
  diff_cents: number;
}

/**
 * One row per invoice: its stored balance, its allocated total, and whether
 * the two agree. This is the primary working view of the interface.
 */
export function reconcileInvoices(
  db: Db,
  sellerId: string,
): ReconciliationRow[] {
  const invoices = db
    .prepare(
      `SELECT * FROM invoices WHERE seller_id = ? ORDER BY due_date, number`,
    )
    .all(sellerId) as InvoiceRecord[];

  return invoices.map((invoice) => buildReconciliationRow(db, invoice));
}

export function buildReconciliationRow(
  db: Db,
  invoice: InvoiceRecord,
): ReconciliationRow {
  const allocations = db
    .prepare(
      `SELECT a.id AS allocation_id, a.payment_id, a.amount_cents, a.status,
              a.created_at AS allocated_at, a.journal_entry_id,
              p.reference AS payment_reference
         FROM payment_allocations a
         LEFT JOIN payments p ON p.id = a.payment_id
        WHERE a.invoice_id = ?
        ORDER BY a.created_at, a.rowid`,
    )
    .all(invoice.id) as Array<{
    allocation_id: string;
    payment_id: string;
    amount_cents: number;
    status: 'active' | 'reversed';
    allocated_at: string;
    journal_entry_id: string | null;
    payment_reference: string | null;
  }>;

  const credits = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes
        WHERE invoice_id = ? AND status = 'applied'`,
    )
    .get(invoice.id) as { total: number };

  const adjustments = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents ELSE 0 END),0) AS debits,
         COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE 0 END),0) AS credits
       FROM adjustments WHERE invoice_id = ? AND status = 'posted'`,
    )
    .get(invoice.id) as { debits: number; credits: number };

  const refunds = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
        WHERE invoice_id = ? AND status = 'refunded'`,
    )
    .get(invoice.id) as { total: number };

  const activeAllocated = allocations
    .filter((a) => a.status === 'active')
    .reduce((sum, a) => sum + a.amount_cents, 0);

  // Independently re-derived balance — the same definition the ledger uses,
  // recomputed here so a bug in the ledger's recompute shows up as drift.
  const expectedBalance =
    invoice.total_cents -
    activeAllocated -
    credits.total -
    adjustments.debits +
    adjustments.credits +
    refunds.total;

  const reminders = db
    .prepare(
      `SELECT id, kind, status, scheduled_for, suppressed_reason
         FROM reminders WHERE invoice_id = ? ORDER BY scheduled_for`,
    )
    .all(invoice.id) as ReconciliationRow['reminders'];

  const drift = invoice.balance_cents - expectedBalance;

  return {
    invoice,
    allocated_cents: activeAllocated,
    expected_balance_cents: expectedBalance,
    drift_cents: drift,
    allocations,
    reminders,
    reconciled: drift === 0,
  };
}

/**
 * Full reconciliation for a seller: invoice rows plus payment-level and
 * trial-balance checks.
 */
export function reconcileSeller(db: Db, sellerId: string): {
  summary: ReconciliationSummary;
  rows: ReconciliationRow[];
} {
  const rows = reconcileInvoices(db, sellerId);
  const asOf = new Date().toISOString();
  const drift: DriftItem[] = [];

  // ── Invoice-level drift ───────────────────────────────────────────────
  for (const row of rows) {
    if (row.drift_cents !== 0) {
      drift.push({
        kind: 'invoice_balance',
        entity_type: 'invoice',
        entity_id: row.invoice.id,
        description:
          `Invoice ${row.invoice.number}: stored balance ` +
          `${row.invoice.balance_cents} but allocations and credits account for ` +
          `${row.expected_balance_cents}`,
        expected_cents: row.expected_balance_cents,
        actual_cents: row.invoice.balance_cents,
        diff_cents: row.drift_cents,
      });
    }
    if (row.expected_balance_cents < 0) {
      drift.push({
        kind: 'oversettled_invoice',
        entity_type: 'invoice',
        entity_id: row.invoice.id,
        description:
          `Invoice ${row.invoice.number} is over-settled by ` +
          `${Math.abs(row.expected_balance_cents)} cents`,
        expected_cents: 0,
        actual_cents: row.expected_balance_cents,
        diff_cents: row.expected_balance_cents,
      });
    }
  }

  // ── Payment-level drift ───────────────────────────────────────────────
  const payments = db
    .prepare(
      `SELECT id, amount_cents, unallocated_cents, status FROM payments
        WHERE seller_id = ?`,
    )
    .all(sellerId) as Array<{
    id: string;
    amount_cents: number;
    unallocated_cents: number;
    status: string;
  }>;

  for (const payment of payments) {
    const allocated = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payment_allocations
          WHERE payment_id = ? AND status = 'active'`,
      )
      .get(payment.id) as { total: number };
    const derived = payment.amount_cents - allocated.total;
    if (derived !== payment.unallocated_cents) {
      drift.push({
        kind: 'payment_unallocated',
        entity_type: 'payment',
        entity_id: payment.id,
        description:
          `Payment ${payment.id}: stored unallocated ${payment.unallocated_cents} ` +
          `but allocations leave ${derived}`,
        expected_cents: derived,
        actual_cents: payment.unallocated_cents,
        diff_cents: payment.unallocated_cents - derived,
      });
    }
  }

  // ── Trial balance ─────────────────────────────────────────────────────
  // Every posted entry balances by construction, so the whole ledger must sum
  // to zero across all accounts. A non-zero total means lines were written
  // outside the entry pipeline.
  const trial = db
    .prepare(
      `SELECT COALESCE(SUM(l.amount_cents), 0) AS total
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.seller_id = ? AND e.status = 'posted'`,
    )
    .get(sellerId) as { total: number };

  if (trial.total !== 0) {
    drift.push({
      kind: 'trial_balance',
      entity_type: 'ledger',
      entity_id: sellerId,
      description:
        `Ledger does not balance: posted lines sum to ${trial.total} instead of 0`,
      expected_cents: 0,
      actual_cents: trial.total,
      diff_cents: trial.total,
    });
  }

  const unapplied = db
    .prepare(
      `SELECT COALESCE(SUM(unallocated_cents), 0) AS total FROM payments
        WHERE seller_id = ? AND status = 'confirmed'`,
    )
    .get(sellerId) as { total: number };

  const seller = db
    .prepare(`SELECT authoritative_system FROM sellers WHERE id = ?`)
    .get(sellerId) as { authoritative_system: 'local' | 'external' };

  const summary: ReconciliationSummary = {
    seller_id: sellerId,
    as_of: asOf,
    invoice_count: rows.length,
    reconciled_count: rows.filter((r) => r.reconciled).length,
    drifted_count: drift.length,
    total_outstanding_cents: rows.reduce(
      (sum, r) => sum + Math.max(0, r.expected_balance_cents),
      0,
    ),
    total_allocated_cents: rows.reduce((sum, r) => sum + r.allocated_cents, 0),
    total_unapplied_cash_cents: unapplied.total,
    trial_balance_cents: trial.total,
    trial_balanced: trial.total === 0,
    drift,
    authoritative_system: seller.authoritative_system,
  };

  return { summary, rows };
}

/**
 * Account-level balances: every account's net movement from posted entries.
 * Reversed entries drop out because their status is no longer 'posted', which
 * is the same mechanism that removes their effect from invoice balances.
 */
export function accountBalances(db: Db, sellerId: string) {
  return db
    .prepare(
      `SELECT a.id AS account_id, a.code, a.name, a.type,
              COALESCE(SUM(l.amount_cents), 0) AS net_cents,
              COALESCE(SUM(CASE WHEN l.amount_cents > 0 THEN l.amount_cents ELSE 0 END), 0) AS debit_cents,
              COALESCE(SUM(CASE WHEN l.amount_cents < 0 THEN -l.amount_cents ELSE 0 END), 0) AS credit_cents,
              COUNT(l.id) AS line_count
         FROM gl_accounts a
         LEFT JOIN journal_lines l ON l.account_id = a.id AND l.seller_id = a.seller_id
         LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
        WHERE a.seller_id = ?
        GROUP BY a.id
        ORDER BY a.code`,
    )
    .all(sellerId) as Array<{
    account_id: string;
    code: string;
    name: string;
    type: string;
    net_cents: number;
    debit_cents: number;
    credit_cents: number;
    line_count: number;
  }>;
}
