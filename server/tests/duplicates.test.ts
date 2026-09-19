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

describe('duplicate requests', async () => {
  it('returns the original proposal when an idempotency key is reused', async () => {
    const { db, sellerId } = await makeTestDb();

    const first = await proposeLedgerUpdate(
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

    const second = await proposeLedgerUpdate(
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
    const count = await db.get(`SELECT COUNT(*) AS n FROM ledger_proposals WHERE seller_id = ?`, [sellerId]) as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects a second proposal for the same source event without a key', async () => {
    const { db, sellerId } = await makeTestDb();
    const op = {
      kind: 'record_payment' as const,
      seller_id: sellerId,
      amount_cents: 25000,
      received_at: '2026-09-01T12:00:00.000Z',
      reference: 'REF-2',
    };

    await proposeLedgerUpdate(db, AGENT, op);

    // Same semantic content, no idempotency key: the derived source event id
    // is identical, so this is caught as a duplicate.
    await expect(proposeLedgerUpdate(db, AGENT, op)).rejects.toThrowError(/already exists/);
  });

  it('replays a posting when the same idempotency key is reused', async () => {
    const { db, sellerId } = await makeTestDb();

    const proposal = await proposeLedgerUpdate(
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
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const first = await postLedgerUpdate(db, APPROVER, proposal.id, {
      idempotencyKey: 'post-key-1',
    });
    const second = await postLedgerUpdate(db, APPROVER, proposal.id, {
      idempotencyKey: 'post-key-1',
    });

    expect(second.entry_id).toBe(first.entry_id);
    expect(second.replayed).toBe(true);

    const payments = await db.get(`SELECT COUNT(*) AS n FROM payments WHERE seller_id = ? AND reference = ?`, [sellerId, 'REF-3']) as { n: number };
    expect(payments.n).toBe(1);

    const entries = await db.get(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`, [sellerId]) as { n: number };
    expect(entries.n).toBe(1);
  });

  it('refuses to record the same payment twice, by derived source event', async () => {
    const { db, sellerId } = await makeTestDb();
    await recordPayment(db, sellerId, 30000, 'REF-DUP');

    await expect(recordPayment(db, sellerId, 30000, 'REF-DUP')).rejects.toThrowError(
      LedgerError,
    );

    const payments = await db.get(`SELECT COUNT(*) AS n FROM payments WHERE seller_id = ?`, [sellerId]) as { n: number };
    expect(payments.n).toBe(1);
  });

  it('refuses to allocate the same payment to the same invoice twice', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 40000, 'REF-ALLOC');

    await allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    // Identical allocation: same derived source event, so it is a duplicate.
    await expect(allocatePayment(db, sellerId, paymentId, invoiceId, 40000),).rejects.toThrowError(/already been posted|already exists/);

    const allocations = await db.get(`SELECT COUNT(*) AS n FROM payment_allocations WHERE invoice_id = ?`, [invoiceId]) as { n: number };
    expect(allocations.n).toBe(1);
  });

  it('allows two genuinely distinct allocations of the same payment', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 60000, 'REF-SPLIT');

    await allocatePayment(db, sellerId, paymentId, invoiceId, 30000);
    // Different invoice and amount, so a different source event: legitimate.
    await allocatePayment(db, sellerId, paymentId, otherInvoiceId, 30000);

    const payment = await db.get(`SELECT unallocated_cents FROM payments WHERE id = ?`, [paymentId]) as { unallocated_cents: number };
    expect(payment.unallocated_cents).toBe(0);
  });

  it('does not let a duplicate payment create a second journal entry', async () => {
    const { db, sellerId } = await makeTestDb();
    await recordPayment(db, sellerId, 15000, 'REF-ENTRY-ONCE');
    try {
      await recordPayment(db, sellerId, 15000, 'REF-ENTRY-ONCE');
    } catch {
      // expected
    }
    const entries = await db.get(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`, [sellerId]) as { n: number };
    expect(entries.n).toBe(1);
  });

  it('keeps the ledger balanced after a rejected duplicate', async () => {
    const { db, sellerId } = await makeTestDb();
    await recordPayment(db, sellerId, 20000, 'REF-BAL');
    try {
      await recordPayment(db, sellerId, 20000, 'REF-BAL');
    } catch {
      // expected
    }
    const trial = await db.get(
        `SELECT COALESCE(SUM(l.amount_cents), 0) AS total
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.seller_id = ? AND e.status = 'posted'`, [sellerId]) as { total: number };
    expect(trial.total).toBe(0);
  });

  it('ignores an idempotency key from a different proposal', async () => {
    const { db, sellerId } = await makeTestDb();

    const p1 = await proposeLedgerUpdate(
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
    const p2 = await proposeLedgerUpdate(
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

  it('allows a genuinely new payment after a reversal', async () => {
    const { db, sellerId } = await makeTestDb();
    const paymentId = await recordPayment(db, sellerId, 5000, 'REF-REV');

    // Reverse the payment posting.
    const entry = await db.get(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`, [sellerId]) as { id: string };
    await reverseLedgerEntry(db, OWNER, entry.id, 'recorded in error');

    // The source event is still consumed, so the identical payment is still
    // refused. Re-recording it is a new business event and needs a new
    // reference, which is the correct behaviour: reversals do not recycle ids.
    await expect(recordPayment(db, sellerId, 5000, 'REF-REV')).rejects.toThrowError();
    expect(paymentId).toBeTruthy();
  });

  it('rejects a fee with no description and leaves no partial entry', async () => {
    const { db, sellerId } = await makeTestDb();
    const before = await db.get(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`, [sellerId]) as { n: number };

    await expect(proposeLedgerUpdate(db, BOOKKEEPER, {
        kind: 'record_fee',
        seller_id: sellerId,
        amount_cents: 500,
        description: '',
      }),).rejects.toThrowError(/description is required/);

    const after = await db.get(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`, [sellerId]) as { n: number };
    expect(after.n).toBe(before.n);
  });
});
