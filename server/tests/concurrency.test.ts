/**
 * Concurrent allocations.
 *
 * Covers the requirement to test concurrent allocations. The scenario that
 * matters: two callers each try to allocate the same money to different
 * invoices, or two callers race for the same invoice. Exactly one may win,
 * and the loser must fail cleanly with no partial write.
 *
 * better-sqlite3 is synchronous, so true parallelism is not available in one
 * process. What is exercised instead is the interleaving that the persistence
 * layer actually has to survive: two proposals planned against the same
 * starting state, then posted in sequence. The second posting must be refused
 * by the revalidation step, because the state it was planned against no
 * longer holds.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
} from '../src/services/ledger';
import { reconcileSeller } from '../src/services/reconciliation';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  makeTestDb,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

describe('concurrent allocations', async () => {
  it('refuses the second of two allocations racing for the same funds', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);

    // A payment of 30000, and two proposals each trying to spend all of it.
    const paymentId = await recordPayment(db, sellerId, 30000, 'REF-RACE');

    const first = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 30000,
    });
    const second = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 30000,
    });

    await approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    await approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });

    // First wins.
    await postLedgerUpdate(db, APPROVER, first.id);

    // Second was planned when the payment still had 30000 unallocated. It
    // must now be refused: the payment state it captured is stale.
    await expect(postLedgerUpdate(db, APPROVER, second.id)).rejects.toThrowError(
      LedgerError,
    );

    const payment = await db.get(`SELECT unallocated_cents FROM payments WHERE id = ?`, [paymentId]) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);

    const allocations = await db.get(
        `SELECT COUNT(*) AS n FROM payment_allocations
          WHERE payment_id = ? AND status = 'active'`, [paymentId]) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('reports the stale-state conflict with the version that changed', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 20000, 'REF-RACE-2');

    const first = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    const second = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 10000,
    });

    await approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    await approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, first.id);

    try {
      await postLedgerUpdate(db, APPROVER, second.id);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe('stale_state');
      const detail = (err as LedgerError).detail as { conflicts: string[] };
      expect(detail.conflicts.join(' ')).toMatch(/payment .* changed version/);
    }
  });

  it('refuses a second allocation racing for the same invoice balance', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    // Invoice is 100000. Two payments of 100000 each, both proposed against
    // the full balance.
    const p1 = await recordPayment(db, sellerId, 100000, 'REF-INV-A');
    const p2 = await recordPayment(db, sellerId, 100000, 'REF-INV-B');

    const first = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: p1,
      invoice_id: invoiceId,
      amount_cents: 100000,
    });
    const second = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: p2,
      invoice_id: invoiceId,
      amount_cents: 100000,
    });
    await approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    await approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });

    await postLedgerUpdate(db, APPROVER, first.id);

    // The invoice is now settled, so the second is refused on invoice state.
    await expect(postLedgerUpdate(db, APPROVER, second.id)).rejects.toThrowError(
      LedgerError,
    );

    const invoice = await db.get(`SELECT balance_cents, status FROM invoices WHERE id = ?`, [invoiceId]) as { balance_cents: number; status: string };
    expect(invoice.balance_cents).toBe(0);
    expect(invoice.status).toBe('paid');
  });

  it('leaves no partial write behind when the second posting fails', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 15000, 'REF-ATOMIC');

    const first = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 15000,
    });
    const second = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 15000,
    });
    await approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    await approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, first.id);

    const entriesBefore = await db.get(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`, [sellerId]) as { n: number };
    const allocationsBefore = await db.get(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`, [sellerId]) as { n: number };

    try {
      await postLedgerUpdate(db, APPROVER, second.id);
    } catch {
      // expected
    }

    const entriesAfter = await db.get(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`, [sellerId]) as { n: number };
    const allocationsAfter = await db.get(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`, [sellerId]) as { n: number };

    // The failed posting must not have written an entry or an allocation.
    expect(entriesAfter.n).toBe(entriesBefore.n);
    expect(allocationsAfter.n).toBe(allocationsBefore.n);
  });

  it('keeps the reconciliation clean after a lost race', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 25000, 'REF-CLEAN');

    const first = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 25000,
    });
    const second = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 25000,
    });
    await approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    await approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, first.id);
    try {
      await postLedgerUpdate(db, APPROVER, second.id);
    } catch {
      // expected
    }

    const { summary } = await reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('serialises two posts of the same proposal without double-posting', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 10000, 'REF-SERIAL');

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const a = await postLedgerUpdate(db, APPROVER, proposal.id);
    const b = await postLedgerUpdate(db, APPROVER, proposal.id);

    expect(b.entry_id).toBe(a.entry_id);
    expect(b.replayed).toBe(true);

    const allocations = await db.get(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`, [sellerId]) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('allows two sequential allocations that together fit the payment', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 40000, 'REF-FIT');

    await allocatePayment(db, sellerId, paymentId, invoiceId, 25000);

    // 15000 remains, so this is planned against a correct unallocated balance
    // and must succeed.
    await allocatePayment(db, sellerId, paymentId, otherInvoiceId, 15000);

    const payment = await db.get(`SELECT unallocated_cents FROM payments WHERE id = ?`, [paymentId]) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);
  });

  it('refuses an allocation planned against a now-overdrawn payment', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 10000, 'REF-OVER');

    // Plan an allocation of the full amount...
    const planned = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    await approveLedgerUpdate(db, APPROVER, planned.id, { reason: 'test' });

    // ...then spend the money through a different route first.
    await allocatePayment(db, sellerId, paymentId, otherInvoiceId, 10000);

    await expect(postLedgerUpdate(db, APPROVER, planned.id)).rejects.toThrowError(
      LedgerError,
    );
  });

  it('tracks entry versions so a concurrent invoice edit is detected', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 10000, 'REF-VERSION');

    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    // Simulate an out-of-band edit to the invoice, as a concurrent posting
    // would produce.
    await db.run(`UPDATE invoices SET version = version + 1 WHERE id = ?`, [invoiceId]);

    try {
      await postLedgerUpdate(db, APPROVER, proposal.id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as LedgerError).code).toBe('stale_state');
    }
  });
});
