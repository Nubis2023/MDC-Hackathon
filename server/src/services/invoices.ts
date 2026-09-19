/**
 * Invoice state — the subledger side of the ledger.
 *
 * `balance_cents` on the invoice row is a cache derived from the source rows:
 * active allocations plus applied credit notes. It is recomputed by this
 * module after every change rather than incremented in place, which is what
 * keeps it consistent under concurrent postings: whichever transaction
 * commits recomputes from the rows it can actually see.
 *
 * The reconciliation interface independently re-derives the balance and
 * compares it against the cache, so a code path that mutates the cache
 * without going through here shows up as drift instead of silently
 * corrupting the books.
 */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type { InvoiceRecord } from '../domain/types';

export function getInvoice(db: Db, invoiceId: string): InvoiceRecord | null {
  const row = db
    .prepare(`SELECT * FROM invoices WHERE id = ?`)
    .get(invoiceId) as InvoiceRecord | undefined;
  return row ?? null;
}

/** Load an invoice, scoped to a seller. Throws if missing or mismatched. */
export function requireInvoice(
  db: Db,
  sellerId: string,
  invoiceId: string,
): InvoiceRecord {
  const invoice = getInvoice(db, invoiceId);
  if (!invoice) {
    throw new LedgerError('not_found', `invoice '${invoiceId}' not found`);
  }
  if (invoice.seller_id !== sellerId) {
    // Deliberately a 404, not a 403: an invoice belonging to another seller
    // should not be distinguishable from one that does not exist.
    throw new LedgerError('not_found', `invoice '${invoiceId}' not found`);
  }
  return invoice;
}

export interface DerivedInvoiceState {
  allocated_cents: number;
  credited_cents: number;
  balance_cents: number;
  status: InvoiceRecord['status'];
}

/**
 * Derive an invoice's outstanding balance from its source rows.
 *
 * The balance is a *cache* on the invoice row; this function is the
 * definition of truth. Three things move a balance, and each is a row whose
 * own status column is the single source of truth for whether it still
 * counts:
 *
 *   - active payment allocations   (reduce the balance)
 *   - applied credit notes         (reduce the balance)
 *   - posted debit adjustments     (reduce — a write-off)
 *   - posted credit adjustments    (increase — a surcharge)
 *
 * Reversing any of those flips its status, so the row drops out of the sum
 * here automatically. That is why reversal needs no special-casing in the
 * balance maths.
 *
 * A negative result means the invoice was over-settled. It is reported rather
 * than clamped to zero, because silently clamping would hide a real problem
 * that the reconciliation interface is supposed to surface.
 */
export function deriveInvoiceState(db: Db, invoiceId: string): DerivedInvoiceState {
  const invoice = getInvoice(db, invoiceId);
  if (!invoice) {
    throw new LedgerError('not_found', `invoice '${invoiceId}' not found`);
  }

  const alloc = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payment_allocations
        WHERE invoice_id = ? AND status = 'active'`,
    )
    .get(invoiceId) as { total: number };

  const credits = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM credit_notes
        WHERE invoice_id = ? AND status = 'applied'`,
    )
    .get(invoiceId) as { total: number };

  const adj = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_cents ELSE 0 END), 0) AS debits,
         COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) AS credits
       FROM adjustments
        WHERE invoice_id = ? AND status = 'posted'`,
    )
    .get(invoiceId) as { debits: number; credits: number };

  // A refund tied to this invoice un-settles it: the customer has their money
  // back, so the invoice is outstanding again. Reversing the refund flips its
  // status and it drops out of this sum, restoring the settled balance.
  const refunds = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM refunds
        WHERE invoice_id = ? AND status = 'refunded'`,
    )
    .get(invoiceId) as { total: number };

  const allocated = alloc.total;
  const credited = credits.total + adj.debits;
  const balance =
    invoice.total_cents - allocated - credited + adj.credits + refunds.total;

  let status: InvoiceRecord['status'];
  if (invoice.status === 'void') {
    status = 'void';
  } else if (balance <= 0) {
    status = 'paid';
  } else if (allocated + credited + adj.credits + refunds.total !== 0) {
    status = 'partially_paid';
  } else {
    status = 'open';
  }

  return {
    allocated_cents: allocated,
    credited_cents: credited,
    balance_cents: balance,
    status,
  };
}

/**
 * Recompute and persist the invoice's cached balance/status, bumping the
 * version. Returns the derived state so the caller can record what changed.
 * Must be called inside the caller's transaction.
 */
export function recomputeInvoiceState(db: Db, invoiceId: string): DerivedInvoiceState {
  const derived = deriveInvoiceState(db, invoiceId);
  const info = db
    .prepare(
      `UPDATE invoices
          SET balance_cents = ?, status = ?, version = version + 1
        WHERE id = ?`,
    )
    .run(derived.balance_cents, derived.status, invoiceId);
  if (info.changes === 0) {
    throw new LedgerError('not_found', `invoice '${invoiceId}' not found`);
  }
  return derived;
}

export interface ListInvoicesOptions {
  sellerId: string;
  status?: InvoiceRecord['status'];
  limit?: number;
}

export function listInvoices(db: Db, options: ListInvoicesOptions): InvoiceRecord[] {
  const limit = options.limit ?? 200;
  if (options.status) {
    return db
      .prepare(
        `SELECT * FROM invoices WHERE seller_id = ? AND status = ?
          ORDER BY due_date, number LIMIT ?`,
      )
      .all(options.sellerId, options.status, limit) as InvoiceRecord[];
  }
  return db
    .prepare(
      `SELECT * FROM invoices WHERE seller_id = ?
        ORDER BY due_date, number LIMIT ?`,
    )
    .all(options.sellerId, limit) as InvoiceRecord[];
}

/** Guard: an invoice that is void or already settled cannot take more money. */
export function assertInvoiceAcceptingPayment(invoice: InvoiceRecord): void {
  if (invoice.status === 'void') {
    throw new LedgerError(
      'validation',
      `invoice ${invoice.number} is void and cannot be paid`,
    );
  }
  if (invoice.balance_cents <= 0) {
    throw new LedgerError(
      'conflict',
      `invoice ${invoice.number} is already settled (balance ${invoice.balance_cents})`,
    );
  }
}
