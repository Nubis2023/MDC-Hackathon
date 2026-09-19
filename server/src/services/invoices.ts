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

import type { SqlDb } from '../db';
import { LedgerError } from '../domain/errors';
import type { Actor, InvoiceRecord } from '../domain/types';
import { writeAuditEvent } from './audit';
import { newId } from './ids';
import { scheduleRemindersForInvoice } from './reminders';

export async function getInvoice(db: SqlDb, invoiceId: string): Promise<InvoiceRecord | null>{
  const row = await db.get(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]) as InvoiceRecord | undefined;
  return row ?? null;
}

/** Load an invoice, scoped to a seller. Throws if missing or mismatched. */
export async function requireInvoice(
  db: SqlDb,
  sellerId: string,
  invoiceId: string,
): Promise<InvoiceRecord>{
  const invoice = await getInvoice(db, invoiceId);
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
export async function deriveInvoiceState(db: SqlDb, invoiceId: string): Promise<DerivedInvoiceState>{
  const invoice = await getInvoice(db, invoiceId);
  if (!invoice) {
    throw new LedgerError('not_found', `invoice '${invoiceId}' not found`);
  }

  const alloc = await db.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payment_allocations
        WHERE invoice_id = ? AND status = 'active'`, [invoiceId]) as { total: number };

  const credits = await db.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM credit_notes
        WHERE invoice_id = ? AND status = 'applied'`, [invoiceId]) as { total: number };

  const adj = await db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_cents ELSE 0 END), 0) AS debits,
         COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) AS credits
       FROM adjustments
        WHERE invoice_id = ? AND status = 'posted'`, [invoiceId]) as { debits: number; credits: number };

  // A refund tied to this invoice un-settles it: the customer has their money
  // back, so the invoice is outstanding again. Reversing the refund flips its
  // status and it drops out of this sum, restoring the settled balance.
  const refunds = await db.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM refunds
        WHERE invoice_id = ? AND status = 'refunded'`, [invoiceId]) as { total: number };

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
export async function recomputeInvoiceState(db: SqlDb, invoiceId: string): Promise<DerivedInvoiceState>{
  const derived = await deriveInvoiceState(db, invoiceId);
  const info = await db.run(
      `UPDATE invoices
          SET balance_cents = ?, status = ?, version = version + 1
        WHERE id = ?`, [derived.balance_cents, derived.status, invoiceId]);
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

export async function listInvoices(db: SqlDb, options: ListInvoicesOptions): Promise<InvoiceRecord[]>{
  const limit = options.limit ?? 200;
  if (options.status) {
    return await db.all(
        `SELECT * FROM invoices WHERE seller_id = ? AND status = ?
          ORDER BY due_date, number LIMIT ?`, [options.sellerId, options.status, limit]) as InvoiceRecord[];
  }
  return await db.all(
      `SELECT * FROM invoices WHERE seller_id = ?
        ORDER BY due_date, number LIMIT ?`, [options.sellerId, limit]) as InvoiceRecord[];
}

/**
 * Guard: an invoice that is void or already settled cannot take more money.
 *
 * Synchronous on purpose. It only inspects the record it is handed, and an
 * async version would let a caller skip the `await` — in which case the throw
 * becomes an unhandled rejection and the guard silently does nothing.
 */
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

// ───────────────────────────── placing an invoice ───────────────────────

export interface CreateInvoiceInput {
  seller_id: string;
  customer_name: string;
  /** Human-facing invoice number, unique per seller. */
  number: string;
  /** ISO date (YYYY-MM-DD). */
  issue_date: string;
  due_date: string;
  currency?: string;
  /** Net of tax, in integer cents. */
  subtotal_cents: number;
  /** Tax in integer cents. Defaults to 0. */
  tax_cents?: number;
}

/**
 * Create an invoice document.
 *
 * This only writes the subledger row and its reminder ladder — it does NOT
 * touch the ledger. Putting the receivable on the books is a separate,
 * controlled step (`issue_invoice`, via propose → approve → post), which is
 * what makes the accounting entry reviewable and keeps the approval gate in
 * front of it.
 *
 * The caller is responsible for the seller-access check; the API route and the
 * agent tools both do it before calling here.
 */
export async function createInvoice(
  db: SqlDb,
  actor: Actor,
  input: CreateInvoiceInput,
): Promise<InvoiceRecord> {
  const customerName = (input.customer_name ?? '').trim();
  if (customerName === '') {
    throw new LedgerError('validation', 'customer_name is required');
  }

  const number = (input.number ?? '').trim();
  if (number === '') {
    throw new LedgerError('validation', 'invoice number is required');
  }

  const subtotal = input.subtotal_cents;
  const tax = input.tax_cents ?? 0;
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    throw new LedgerError(
      'validation',
      'subtotal_cents must be a non-negative integer number of cents',
    );
  }
  if (!Number.isInteger(tax) || tax < 0) {
    throw new LedgerError(
      'validation',
      'tax_cents must be a non-negative integer number of cents',
    );
  }
  if (subtotal + tax <= 0) {
    throw new LedgerError('validation', 'an invoice must total more than zero');
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(input.issue_date)) {
    throw new LedgerError('validation', 'issue_date must be YYYY-MM-DD');
  }
  if (!isoDate.test(input.due_date)) {
    throw new LedgerError('validation', 'due_date must be YYYY-MM-DD');
  }
  if (input.due_date < input.issue_date) {
    throw new LedgerError(
      'validation',
      'due_date cannot be earlier than issue_date',
    );
  }

  // A duplicate number would be caught by unique(seller_id, number), but that
  // surfaces as a driver-level constraint error. Checking first gives a
  // message the caller can act on.
  const existing = await db.get<{ id: string }>(
    `SELECT id FROM invoices WHERE seller_id = ? AND number = ?`,
    [input.seller_id, number],
  );
  if (existing) {
    throw new LedgerError(
      'conflict',
      `invoice ${number} already exists for this seller`,
      { detail: { invoice_id: existing.id } },
    );
  }

  const total = subtotal + tax;
  const id = newId('inv');

  // Stored with balance_cents = total and status 'open': an unissued invoice
  // is still fully outstanding, and createInvoice does not post anything, so
  // the subledger and the ledger agree at this point (neither has an entry).
  await db.run(
    `INSERT INTO invoices
       (id, seller_id, customer_name, number, issue_date, due_date, currency,
        subtotal_cents, tax_cents, total_cents, balance_cents, status, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1)`,
    [
      id,
      input.seller_id,
      customerName,
      number,
      input.issue_date,
      input.due_date,
      input.currency ?? 'USD',
      subtotal,
      tax,
      total,
      total,
    ],
  );

  const invoice = await getInvoice(db, id);
  if (!invoice) {
    throw new LedgerError('not_found', 'invoice vanished after insert');
  }

  // The reminder ladder is scheduled here so the invoice is immediately
  // visible in the reminders view, and so a later posting that settles it has
  // something to suppress.
  await scheduleRemindersForInvoice(db, invoice);

  await writeAuditEvent(db, {
    seller_id: input.seller_id,
    actor,
    action: 'invoice.created',
    entity_type: 'invoice',
    entity_id: id,
    detail: {
      number,
      customer_name: customerName,
      subtotal_cents: subtotal,
      tax_cents: tax,
      total_cents: total,
      issue_date: input.issue_date,
      due_date: input.due_date,
    },
  });

  return invoice;
}
