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

describe('concurrent allocations', () => {
  it('refuses the second of two allocations racing for the same funds', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);

    // A payment of 30000, and two proposals each trying to spend all of it.
    const paymentId = recordPayment(db, sellerId, 30000, 'REF-RACE');

    const first = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 30000,
    });
    const second = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 30000,
    });

    approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });

    // First wins.
    postLedgerUpdate(db, APPROVER, first.id);

    // Second was planned when the payment still had 30000 unallocated. It
    // must now be refused: the payment state it captured is stale.
    expect(() => postLedgerUpdate(db, APPROVER, second.id)).toThrowError(
      LedgerError,
    );

    const payment = db
      .prepare(`SELECT unallocated_cents FROM payments WHERE id = ?`)
      .get(paymentId) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);

    const allocations = db
      .prepare(
        `SELECT COUNT(*) AS n FROM payment_allocations
          WHERE payment_id = ? AND status = 'active'`,
      )
      .get(paymentId) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('reports the stale-state conflict with the version that changed', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 20000, 'REF-RACE-2');

    const first = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    const second = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 10000,
    });

    approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, first.id);

    try {
      postLedgerUpdate(db, APPROVER, second.id);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe('stale_state');
      const detail = (err as LedgerError).detail as { conflicts: string[] };
      expect(detail.conflicts.join(' ')).toMatch(/payment .* changed version/);
    }
  });

  it('refuses a second allocation racing for the same invoice balance', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    // Invoice is 100000. Two payments of 100000 each, both proposed against
    // the full balance.
    const p1 = recordPayment(db, sellerId, 100000, 'REF-INV-A');
    const p2 = recordPayment(db, sellerId, 100000, 'REF-INV-B');

    const first = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: p1,
      invoice_id: invoiceId,
      amount_cents: 100000,
    });
    const second = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: p2,
      invoice_id: invoiceId,
      amount_cents: 100000,
    });
    approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });

    postLedgerUpdate(db, APPROVER, first.id);

    // The invoice is now settled, so the second is refused on invoice state.
    expect(() => postLedgerUpdate(db, APPROVER, second.id)).toThrowError(
      LedgerError,
    );

    const invoice = db
      .prepare(`SELECT balance_cents, status FROM invoices WHERE id = ?`)
      .get(invoiceId) as { balance_cents: number; status: string };
    expect(invoice.balance_cents).toBe(0);
    expect(invoice.status).toBe('paid');
  });

  it('leaves no partial write behind when the second posting fails', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 15000, 'REF-ATOMIC');

    const first = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 15000,
    });
    const second = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 15000,
    });
    approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, first.id);

    const entriesBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    const allocationsBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`)
      .get(sellerId) as { n: number };

    try {
      postLedgerUpdate(db, APPROVER, second.id);
    } catch {
      // expected
    }

    const entriesAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    const allocationsAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`)
      .get(sellerId) as { n: number };

    // The failed posting must not have written an entry or an allocation.
    expect(entriesAfter.n).toBe(entriesBefore.n);
    expect(allocationsAfter.n).toBe(allocationsBefore.n);
  });

  it('keeps the reconciliation clean after a lost race', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 25000, 'REF-CLEAN');

    const first = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 25000,
    });
    const second = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: otherInvoiceId,
      amount_cents: 25000,
    });
    approveLedgerUpdate(db, APPROVER, first.id, { reason: 'test' });
    approveLedgerUpdate(db, APPROVER, second.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, first.id);
    try {
      postLedgerUpdate(db, APPROVER, second.id);
    } catch {
      // expected
    }

    const { summary } = reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('serialises two posts of the same proposal without double-posting', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 10000, 'REF-SERIAL');

    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const a = postLedgerUpdate(db, APPROVER, proposal.id);
    const b = postLedgerUpdate(db, APPROVER, proposal.id);

    expect(b.entry_id).toBe(a.entry_id);
    expect(b.replayed).toBe(true);

    const allocations = db
      .prepare(`SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('allows two sequential allocations that together fit the payment', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-FIT');

    allocatePayment(db, sellerId, paymentId, invoiceId, 25000);

    // 15000 remains, so this is planned against a correct unallocated balance
    // and must succeed.
    allocatePayment(db, sellerId, paymentId, otherInvoiceId, 15000);

    const payment = db
      .prepare(`SELECT unallocated_cents FROM payments WHERE id = ?`)
      .get(paymentId) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);
  });

  it('refuses an allocation planned against a now-overdrawn payment', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 10000, 'REF-OVER');

    // Plan an allocation of the full amount...
    const planned = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    approveLedgerUpdate(db, APPROVER, planned.id, { reason: 'test' });

    // ...then spend the money through a different route first.
    allocatePayment(db, sellerId, paymentId, otherInvoiceId, 10000);

    expect(() => postLedgerUpdate(db, APPROVER, planned.id)).toThrowError(
      LedgerError,
    );
  });

  it('tracks entry versions so a concurrent invoice edit is detected', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 10000, 'REF-VERSION');

    const proposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    // Simulate an out-of-band edit to the invoice, as a concurrent posting
    // would produce.
    db.prepare(`UPDATE invoices SET version = version + 1 WHERE id = ?`).run(
      invoiceId,
    );

    try {
      postLedgerUpdate(db, APPROVER, proposal.id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as LedgerError).code).toBe('stale_state');
    }
  });
});
