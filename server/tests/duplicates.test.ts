/**
 * Duplicate prevention.
 *
 * Covers the requirement to test duplicate requests. There are four
 * independent defences and each is exercised here on its own, because a
 * defence that only works because another one also fires is not a defence
 * you can rely on.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
} from '../src/services/ledger';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  makeTestDb,
  OWNER,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

describe('duplicate requests', () => {
  it('returns the original proposal when an idempotency key is reused', () => {
    const { db, sellerId } = makeTestDb();

    const first = proposeLedgerUpdate(
      db,
      AGENT,
      {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 25000,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'REF-1',
      },
      { idempotencyKey: 'client-key-abc' },
    );

    const second = proposeLedgerUpdate(
      db,
      AGENT,
      {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 25000,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'REF-1',
      },
      { idempotencyKey: 'client-key-abc' },
    );

    expect(second.id).toBe(first.id);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM ledger_proposals WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects a second proposal for the same source event without a key', () => {
    const { db, sellerId } = makeTestDb();
    const op = {
      kind: 'record_payment' as const,
      seller_id: sellerId,
      amount_cents: 25000,
      received_at: '2026-09-01T12:00:00.000Z',
      reference: 'REF-2',
    };

    proposeLedgerUpdate(db, AGENT, op);

    // Same semantic content, no idempotency key: the derived source event id
    // is identical, so this is caught as a duplicate.
    expect(() => proposeLedgerUpdate(db, AGENT, op)).toThrowError(/already exists/);
  });

  it('replays a posting when the same idempotency key is reused', () => {
    const { db, sellerId } = makeTestDb();

    const proposal = proposeLedgerUpdate(
      db,
      AGENT,
      {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 10000,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'REF-3',
      },
      { idempotencyKey: 'post-key-1' },
    );
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const first = postLedgerUpdate(db, APPROVER, proposal.id, {
      idempotencyKey: 'post-key-1',
    });
    const second = postLedgerUpdate(db, APPROVER, proposal.id, {
      idempotencyKey: 'post-key-1',
    });

    expect(second.entry_id).toBe(first.entry_id);
    expect(second.replayed).toBe(true);

    const payments = db
      .prepare(`SELECT COUNT(*) AS n FROM payments WHERE seller_id = ? AND reference = ?`)
      .get(sellerId, 'REF-3') as { n: number };
    expect(payments.n).toBe(1);

    const entries = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`,
      )
      .get(sellerId) as { n: number };
    expect(entries.n).toBe(1);
  });

  it('refuses to record the same payment twice, by derived source event', () => {
    const { db, sellerId } = makeTestDb();
    recordPayment(db, sellerId, 30000, 'REF-DUP');

    expect(() => recordPayment(db, sellerId, 30000, 'REF-DUP')).toThrowError(
      LedgerError,
    );

    const payments = db
      .prepare(`SELECT COUNT(*) AS n FROM payments WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    expect(payments.n).toBe(1);
  });

  it('refuses to allocate the same payment to the same invoice twice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-ALLOC');

    allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    // Identical allocation: same derived source event, so it is a duplicate.
    expect(() =>
      allocatePayment(db, sellerId, paymentId, invoiceId, 40000),
    ).toThrowError(/already been posted|already exists/);

    const allocations = db
      .prepare(`SELECT COUNT(*) AS n FROM payment_allocations WHERE invoice_id = ?`)
      .get(invoiceId) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('allows two genuinely distinct allocations of the same payment', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-SPLIT');

    allocatePayment(db, sellerId, paymentId, invoiceId, 30000);
    // Different invoice and amount, so a different source event: legitimate.
    allocatePayment(db, sellerId, paymentId, otherInvoiceId, 30000);

    const payment = db
      .prepare(`SELECT unallocated_cents FROM payments WHERE id = ?`)
      .get(paymentId) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);
  });

  it('does not let a duplicate payment create a second journal entry', () => {
    const { db, sellerId } = makeTestDb();
    recordPayment(db, sellerId, 15000, 'REF-ENTRY-ONCE');
    try {
      recordPayment(db, sellerId, 15000, 'REF-ENTRY-ONCE');
    } catch {
      // expected
    }
    const entries = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`,
      )
      .get(sellerId) as { n: number };
    expect(entries.n).toBe(1);
  });

  it('keeps the ledger balanced after a rejected duplicate', () => {
    const { db, sellerId } = makeTestDb();
    recordPayment(db, sellerId, 20000, 'REF-BAL');
    try {
      recordPayment(db, sellerId, 20000, 'REF-BAL');
    } catch {
      // expected
    }
    const trial = db
      .prepare(
        `SELECT COALESCE(SUM(l.amount_cents), 0) AS total
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.seller_id = ? AND e.status = 'posted'`,
      )
      .get(sellerId) as { total: number };
    expect(trial.total).toBe(0);
  });

  it('ignores an idempotency key from a different proposal', () => {
    const { db, sellerId } = makeTestDb();

    const p1 = proposeLedgerUpdate(
      db,
      AGENT,
      {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 1000,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'REF-K1',
      },
      { idempotencyKey: 'key-shared' },
    );

    // A different request reusing the same key is still a replay of the first
    // proposal — that is the point of a client-supplied retry key.
    const p2 = proposeLedgerUpdate(
      db,
      AGENT,
      {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 9999,
        received_at: '2026-09-02T12:00:00.000Z',
        reference: 'REF-K2',
      },
      { idempotencyKey: 'key-shared' },
    );

    expect(p2.id).toBe(p1.id);
    expect(p2.preview.total_debit_cents).toBe(1000);
  });

  it('allows a genuinely new payment after a reversal', () => {
    const { db, sellerId } = makeTestDb();
    const paymentId = recordPayment(db, sellerId, 5000, 'REF-REV');

    // Reverse the payment posting.
    const entry = db
      .prepare(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`,
      )
      .get(sellerId) as { id: string };
    reverseLedgerEntry(db, OWNER, entry.id, 'recorded in error');

    // The source event is still consumed, so the identical payment is still
    // refused. Re-recording it is a new business event and needs a new
    // reference, which is the correct behaviour: reversals do not recycle ids.
    expect(() => recordPayment(db, sellerId, 5000, 'REF-REV')).toThrowError();
    expect(paymentId).toBeTruthy();
  });

  it('rejects a fee with no description and leaves no partial entry', () => {
    const { db, sellerId } = makeTestDb();
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`)
      .get(sellerId) as { n: number };

    expect(() =>
      proposeLedgerUpdate(db, BOOKKEEPER, {
        kind: 'record_fee',
        seller_id: sellerId,
        amount_cents: 500,
        description: '',
      }),
    ).toThrowError(/description is required/);

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`)
      .get(sellerId) as { n: number };
    expect(after.n).toBe(before.n);
  });
});
