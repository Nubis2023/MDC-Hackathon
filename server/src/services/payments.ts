/** Payment reads and allocation bookkeeping. */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type { PaymentRecord } from '../domain/types';

export interface PaymentAllocationRecord {
  id: string;
  seller_id: string;
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
  status: 'active' | 'reversed';
  created_at: string;
}

export function getPayment(db: Db, paymentId: string): PaymentRecord | null {
  const row = db
    .prepare(`SELECT * FROM payments WHERE id = ?`)
    .get(paymentId) as PaymentRecord | undefined;
  return row ?? null;
}

export function requirePayment(
  db: Db,
  sellerId: string,
  paymentId: string,
): PaymentRecord {
  const payment = getPayment(db, paymentId);
  if (!payment || payment.seller_id !== sellerId) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  return payment;
}

export function listPayments(db: Db, sellerId: string, limit = 200): PaymentRecord[] {
  return db
    .prepare(
      `SELECT * FROM payments WHERE seller_id = ?
        ORDER BY received_at DESC, rowid DESC LIMIT ?`,
    )
    .all(sellerId, limit) as PaymentRecord[];
}

export function listAllocationsForInvoice(
  db: Db,
  invoiceId: string,
): PaymentAllocationRecord[] {
  return db
    .prepare(
      `SELECT * FROM payment_allocations WHERE invoice_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(invoiceId) as PaymentAllocationRecord[];
}

export function getActiveAllocations(
  db: Db,
  paymentId: string,
): PaymentAllocationRecord[] {
  return db
    .prepare(
      `SELECT * FROM payment_allocations
        WHERE payment_id = ? AND status = 'active'
        ORDER BY created_at, rowid`,
    )
    .all(paymentId) as PaymentAllocationRecord[];
}

/**
 * How much of a payment is still available to allocate, derived from its
 * active allocations rather than trusting `unallocated_cents`. Both are
 * checked against each other by the reconciliation interface.
 */
export function deriveUnallocatedCents(db: Db, paymentId: string): number {
  const payment = getPayment(db, paymentId);
  if (!payment) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payment_allocations
        WHERE payment_id = ? AND status = 'active'`,
    )
    .get(paymentId) as { total: number };
  return payment.amount_cents - row.total;
}

/**
 * Recompute a payment's cached unallocated amount from its active
 * allocations and bump the version. Must run inside the caller's transaction.
 */
export function recomputePaymentUnallocated(db: Db, paymentId: string): number {
  const unallocated = deriveUnallocatedCents(db, paymentId);
  const info = db
    .prepare(
      `UPDATE payments SET unallocated_cents = ?, version = version + 1 WHERE id = ?`,
    )
    .run(unallocated, paymentId);
  if (info.changes === 0) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  return unallocated;
}

export function assertPaymentAllocatable(payment: PaymentRecord): void {
  if (payment.status !== 'confirmed') {
    throw new LedgerError(
      'conflict',
      `payment '${payment.id}' is '${payment.status}' and cannot be allocated`,
    );
  }
}

/** Allocations created by a given journal entry, for reversal. */
export function allocationsForEntry(
  db: Db,
  entrySourceId: string,
): PaymentAllocationRecord[] {
  // Allocation postings carry the allocation id as their source_id, so this
  // resolves an entry back to the row it created.
  return db
    .prepare(`SELECT * FROM payment_allocations WHERE id = ?`)
    .all(entrySourceId) as PaymentAllocationRecord[];
}
