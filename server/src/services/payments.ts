/** Payment reads and allocation bookkeeping. */

import type { SqlDb } from '../db';
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

export async function getPayment(db: SqlDb, paymentId: string): Promise<PaymentRecord | null>{
  const row = await db.get(`SELECT * FROM payments WHERE id = ?`, [paymentId]) as PaymentRecord | undefined;
  return row ?? null;
}

export async function requirePayment(
  db: SqlDb,
  sellerId: string,
  paymentId: string,
): Promise<PaymentRecord>{
  const payment = await getPayment(db, paymentId);
  if (!payment || payment.seller_id !== sellerId) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  return payment;
}

export async function listPayments(db: SqlDb, sellerId: string, limit = 200): Promise<PaymentRecord[]>{
  return await db.all(
      `SELECT * FROM payments WHERE seller_id = ?
        ORDER BY received_at DESC, id DESC LIMIT ?`, [sellerId, limit]) as PaymentRecord[];
}

export async function listAllocationsForInvoice(
  db: SqlDb,
  invoiceId: string,
): Promise<PaymentAllocationRecord[]>{
  return await db.all(
      `SELECT * FROM payment_allocations WHERE invoice_id = ?
        ORDER BY created_at, id`, [invoiceId]) as PaymentAllocationRecord[];
}

export async function getActiveAllocations(
  db: SqlDb,
  paymentId: string,
): Promise<PaymentAllocationRecord[]>{
  return await db.all(
      `SELECT * FROM payment_allocations
        WHERE payment_id = ? AND status = 'active'
        ORDER BY created_at, id`, [paymentId]) as PaymentAllocationRecord[];
}

/**
 * How much of a payment is still available to allocate, derived from its
 * active allocations rather than trusting `unallocated_cents`. Both are
 * checked against each other by the reconciliation interface.
 */
export async function deriveUnallocatedCents(db: SqlDb, paymentId: string): Promise<number>{
  const payment = await getPayment(db, paymentId);
  if (!payment) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  const row = await db.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payment_allocations
        WHERE payment_id = ? AND status = 'active'`, [paymentId]) as { total: number };
  return payment.amount_cents - row.total;
}

/**
 * Recompute a payment's cached unallocated amount from its active
 * allocations and bump the version. Must run inside the caller's transaction.
 */
export async function recomputePaymentUnallocated(db: SqlDb, paymentId: string): Promise<number>{
  const unallocated = await deriveUnallocatedCents(db, paymentId);
  const info = await db.run(
      `UPDATE payments SET unallocated_cents = ?, version = version + 1 WHERE id = ?`, [unallocated, paymentId]);
  if (info.changes === 0) {
    throw new LedgerError('not_found', `payment '${paymentId}' not found`);
  }
  return unallocated;
}

export async function assertPaymentAllocatable(payment: PaymentRecord): Promise<void>{
  if (payment.status !== 'confirmed') {
    throw new LedgerError(
      'conflict',
      `payment '${payment.id}' is '${payment.status}' and cannot be allocated`,
    );
  }
}

/** Allocations created by a given journal entry, for reversal. */
export async function allocationsForEntry(
  db: SqlDb,
  entrySourceId: string,
): Promise<PaymentAllocationRecord[]>{
  // Allocation postings carry the allocation id as their source_id, so this
  // resolves an entry back to the row it created.
  return await db.all(`SELECT * FROM payment_allocations WHERE id = ?`, [entrySourceId]) as PaymentAllocationRecord[];
}
