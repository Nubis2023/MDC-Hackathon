/**
 * Failed transactions and transaction atomicity.
 *
 * Covers the requirement to test failed transactions. The invariant under
 * test is that a posting either commits entirely — journal entry, subledger
 * row, invoice balances, audit event — or commits nothing at all. There is no
 * intermediate state where an allocation exists without its journal entry, or
 * a balance moved without a corresponding line.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  rejectLedgerUpdate,
} from '../src/services/ledger';
import { accountBalances, reconcileSeller } from '../src/services/reconciliation';
import { createAdjustment, approveAdjustment } from '../src/services/adjustments';
import { MAPPING_KEYS } from '../src/domain/types';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  OWNER,
  makeTestDb,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

function counts(db: import('../src/db').Db, sellerId: string) {
  const q = (sql: string) => (db.prepare(sql).get(sellerId) as { n: number }).n;
  return {
    entries: q(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`),
    lines: q(`SELECT COUNT(*) AS n FROM journal_lines WHERE seller_id = ?`),
    allocations: q(
      `SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`,
    ),
    audit: q(`SELECT COUNT(*) AS n FROM audit_events WHERE seller_id = ?`),
    proposals: q(`SELECT COUNT(*) AS n FROM ledger_proposals WHERE seller_id = ?`),
  };
}

describe('failed transactions', () => {
  it('rolls back the journal entry when the subledger effect fails', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 10000, 'REF-TX');

    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const before = counts(db, sellerId);

    // Delete the invoice out from under the allocation. The plan re-reads the
    // invoice at post time and must refuse, rolling back the entry insert.
    db.prepare(`DELETE FROM reminders WHERE invoice_id = ?`).run(invoiceId);
    db.prepare(`DELETE FROM invoices WHERE id = ?`).run(invoiceId);

    expect(() => postLedgerUpdate(db, APPROVER, proposal.id)).toThrowError(
      LedgerError,
    );

    const after = counts(db, sellerId);
    // No new journal entry or line survived the failure.
    expect(after.entries).toBe(before.entries);
    expect(after.lines).toBe(before.lines);
    expect(after.allocations).toBe(before.allocations);
  });

  it('leaves no entry when an unbalanced entry is refused by the database', () => {
    const { db, sellerId } = makeTestDb();

    // Bypass the service entirely and try to post an unbalanced entry
    // directly. The schema trigger must abort the transaction, so nothing
    // survives — not even the pending entry row.
    const attempt = db.transaction(() => {
      db.prepare(
        `INSERT INTO journal_entries
           (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
            source_event_id, entry_kind, status)
         VALUES ('je_bad', ?, 999, '2026-09-01', 'unbalanced', 'test', 'x',
                 'evt_bad', 'standard', 'pending')`,
      ).run(sellerId);
      db.prepare(
        `INSERT INTO journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
         VALUES ('jl_bad', ?, 'je_bad', 1, ?, 500)`,
      ).run(sellerId, `${sellerId}__cash`);
      // Only one line and it does not sum to zero: the trigger must abort.
      db.prepare(
        `UPDATE journal_entries SET status = 'posted', posted_at = 'now' WHERE id = 'je_bad'`,
      ).run();
    });

    expect(() => attempt()).toThrowError(/at least two lines|sum to zero/);

    // The whole transaction rolled back, so the entry row is gone too.
    const entry = db
      .prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE id = 'je_bad'`)
      .get() as { n: number };
    expect(entry.n).toBe(0);

    // And no unbalanced entry is posted anywhere in the ledger.
    const postedUnbalanced = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ? AND status = 'posted'`,
      )
      .get(sellerId) as { n: number };
    expect(postedUnbalanced.n).toBe(0);
  });

  it('refuses to post an adjustment that was never approved', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    // Create a draft adjustment and try to post it without approval.
    const adjustment = createAdjustment(db, BOOKKEEPER, {
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 5000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'unapproved write-off',
    });

    expect(() =>
      proposeLedgerUpdate(db, BOOKKEEPER, {
        kind: 'post_adjustment',
        seller_id: sellerId,
        adjustment_id: adjustment.id,
      }),
    ).toThrowError(/approved before it can be posted/);
  });

  it('refuses to post a rejected proposal', () => {
    const { db, sellerId } = makeTestDb();
    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    rejectLedgerUpdate(db, APPROVER, proposal.id, 'not authorised');

    expect(() => postLedgerUpdate(db, APPROVER, proposal.id)).toThrowError(
      /rejected/,
    );
  });

  it('refuses an allocation exceeding the payment amount', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 1000, 'REF-SMALL');

    expect(() =>
      proposeLedgerUpdate(db, AGENT, {
        kind: 'allocate_payment',
        seller_id: sellerId,
        payment_id: paymentId,
        invoice_id: invoiceId,
        amount_cents: 99999,
      }),
    ).toThrowError(/exceeds the payment's unallocated balance/);
  });

  it('refuses a non-positive amount', () => {
    const { db, sellerId } = makeTestDb();
    expect(() =>
      proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 0,
        received_at: '2026-09-01T12:00:00.000Z',
      }),
    ).toThrowError(/must be a positive integer/);

    expect(() =>
      proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: -500,
        received_at: '2026-09-01T12:00:00.000Z',
      }),
    ).toThrowError(/must be a positive integer/);
  });

  it('refuses to pay an invoice that is already settled', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    recordPayment(db, sellerId, 100000, 'REF-SETTLE-A');
    const p2 = recordPayment(db, sellerId, 100000, 'REF-SETTLE-B');
    allocatePayment(db, sellerId, p2, invoiceId, 100000);

    const p3 = recordPayment(db, sellerId, 5000, 'REF-SETTLE-C');
    // Allocating to a settled invoice must be refused at propose time.
    expect(() => allocatePayment(db, sellerId, p3, invoiceId, 5000)).toThrowError(
      LedgerError,
    );
  });

  it('keeps the ledger balanced across a failed posting', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 7000, 'REF-BALANCE');

    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 7000,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, proposal.id);

    // Now attempt something that must fail.
    try {
      allocatePayment(db, sellerId, paymentId, invoiceId, 7000);
    } catch {
      // expected: the payment has nothing left
    }

    const { summary } = reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('does not record an audit event for a posting that failed', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 3000, 'REF-AUDIT');

    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 3000,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const before = counts(db, sellerId);

    // Corrupt the payment state so revalidation fails.
    db.prepare(`UPDATE payments SET version = version + 5 WHERE id = ?`).run(
      paymentId,
    );

    expect(() => postLedgerUpdate(db, APPROVER, proposal.id)).toThrowError(
      LedgerError,
    );

    const after = counts(db, sellerId);
    expect(after.audit).toBe(before.audit);
  });

  it('refuses to create an adjustment with no account mapping', () => {
    const { db, sellerId } = makeTestDb();
    expect(() =>
      createAdjustment(db, BOOKKEEPER, {
        seller_id: sellerId,
        amount_cents: 1000,
        direction: 'debit',
        mapping_key: 'not_a_configured_key',
        memo: 'bad mapping',
      }),
    ).toThrowError(/no account mapping configured/);
  });

  it('refuses an adjustment the creator tries to approve themselves', () => {
    const { db, sellerId } = makeTestDb();
    const adjustment = createAdjustment(db, OWNER, {
      seller_id: sellerId,
      amount_cents: 1000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'self approved?',
    });

    expect(() => approveAdjustment(db, OWNER, sellerId, adjustment.id)).toThrowError(
      /cannot be approved by the actor that created it/,
    );
  });

  it('keeps account balances at zero before any posting', () => {
    const { db, sellerId } = makeTestDb();
    const balances = accountBalances(db, sellerId);
    expect(balances.every((b) => b.net_cents === 0)).toBe(true);
  });
});
