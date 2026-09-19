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

async function counts(db: SqlDb, sellerId: string) {
  const q = async (sql: string) => ((await db.get(sql, [sellerId])) as { n: number }).n;
  return {
    // Each count is awaited here rather than left as a promise: returning
    // promises would make `expect(after.entries).toBe(before.entries)` compare
    // two distinct Promise objects and always fail.
    entries: await q(`SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`),
    lines: await q(`SELECT COUNT(*) AS n FROM journal_lines WHERE seller_id = ?`),
    allocations: await q(
      `SELECT COUNT(*) AS n FROM payment_allocations WHERE seller_id = ?`,
    ),
    audit: await q(`SELECT COUNT(*) AS n FROM audit_events WHERE seller_id = ?`),
    proposals: await q(`SELECT COUNT(*) AS n FROM ledger_proposals WHERE seller_id = ?`),
  };
}

describe('failed transactions', () => {
  it('rolls back the journal entry when the subledger effect fails', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 10000, 'REF-TX');

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 10000,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const before = await counts(db, sellerId);

    // Delete the invoice out from under the allocation. The plan re-reads the
    // invoice at post time and must refuse, rolling back the entry insert.
    await db.run(`DELETE FROM reminders WHERE invoice_id = ?`, [invoiceId]);
    await db.run(`DELETE FROM invoices WHERE id = ?`, [invoiceId]);

    await expect(postLedgerUpdate(db, APPROVER, proposal.id)).rejects.toThrowError(
      LedgerError,
    );

    const after = await counts(db, sellerId);
    // No new journal entry or line survived the failure.
    expect(after.entries).toBe(before.entries);
    expect(after.lines).toBe(before.lines);
    expect(after.allocations).toBe(before.allocations);
  });

  it('leaves no entry when an unbalanced entry is refused by the database', async () => {
    const { db, sellerId } = await makeTestDb();

    // Bypass the service entirely and try to post an unbalanced entry
    // directly. The schema trigger must abort the transaction, so nothing
    // survives — not even the pending entry row.
    // Wrapped in a thunk: db.transaction() starts the transaction immediately,
    // so calling it here would run the failure during setup rather than at the
    // assertion.
    const attempt = () =>
      db.transaction(async () => {
      await db.run(
        `INSERT INTO journal_entries
           (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
            source_event_id, entry_kind, status)
         VALUES ('je_bad', ?, 999, '2026-09-01', 'unbalanced', 'test', 'x',
                 'evt_bad', 'standard', 'pending')`,
        [sellerId],
      );
      await db.run(
        `INSERT INTO journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
         VALUES ('jl_bad', ?, 'je_bad', 1, ?, 500)`,
        [sellerId, `${sellerId}__cash`],
      );
      // Only one line and it does not sum to zero: the trigger must abort.
      await db.run(
        `UPDATE journal_entries SET status = 'posted', posted_at = 'now' WHERE id = 'je_bad'`,
      );
    });

    // The callback is async, so the failure arrives as a rejection rather than
    // a synchronous throw — `.rejects` is what observes it.
    await expect(attempt()).rejects.toThrowError(/at least two lines|sum to zero/);

    // The whole transaction rolled back, so the entry row is gone too.
    const entry = await db.get(`SELECT COUNT(*) AS n FROM journal_entries WHERE id = 'je_bad'`) as { n: number };
    expect(entry.n).toBe(0);

    // And no unbalanced entry is posted anywhere in the ledger.
    const postedUnbalanced = await db.get(
        `SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ? AND status = 'posted'`, [sellerId]) as { n: number };
    expect(postedUnbalanced.n).toBe(0);
  });

  it('refuses to post an adjustment that was never approved', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    // Create a draft adjustment and try to post it without approval.
    const adjustment = await createAdjustment(db, BOOKKEEPER, {
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 5000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'unapproved write-off',
    });

    await expect(proposeLedgerUpdate(db, BOOKKEEPER, {
        kind: 'post_adjustment',
        seller_id: sellerId,
        adjustment_id: adjustment.id,
      }),).rejects.toThrowError(/approved before it can be posted/);
  });

  it('refuses to post a rejected proposal', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    await rejectLedgerUpdate(db, APPROVER, proposal.id, 'not authorised');

    await expect(postLedgerUpdate(db, APPROVER, proposal.id)).rejects.toThrowError(
      /rejected/,
    );
  });

  it('refuses an allocation exceeding the payment amount', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 1000, 'REF-SMALL');

    await expect(
      proposeLedgerUpdate(db, AGENT, {
        kind: 'allocate_payment',
        seller_id: sellerId,
        payment_id: paymentId,
        invoice_id: invoiceId,
        amount_cents: 99999,
      }),
    ).rejects.toThrowError(/exceeds the payment's unallocated balance/);
  });

  it('refuses a non-positive amount', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 0,
        received_at: '2026-09-01T12:00:00.000Z',
      }),).rejects.toThrowError(/must be a positive integer/);

    await expect(proposeLedgerUpdate(db, AGENT, {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: -500,
        received_at: '2026-09-01T12:00:00.000Z',
      }),).rejects.toThrowError(/must be a positive integer/);
  });

  it('refuses to pay an invoice that is already settled', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await recordPayment(db, sellerId, 100000, 'REF-SETTLE-A');
    const p2 = await recordPayment(db, sellerId, 100000, 'REF-SETTLE-B');
    await allocatePayment(db, sellerId, p2, invoiceId, 100000);

    const p3 = await recordPayment(db, sellerId, 5000, 'REF-SETTLE-C');
    // Allocating to a settled invoice must be refused at propose time.
    await expect(allocatePayment(db, sellerId, p3, invoiceId, 5000)).rejects.toThrowError(
      LedgerError,
    );
  });

  it('keeps the ledger balanced across a failed posting', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 7000, 'REF-BALANCE');

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 7000,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, proposal.id);

    // Now attempt something that must fail.
    try {
      await allocatePayment(db, sellerId, paymentId, invoiceId, 7000);
    } catch {
      // expected: the payment has nothing left
    }

    const { summary } = await reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('does not record an audit event for a posting that failed', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 3000, 'REF-AUDIT');

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 3000,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });

    const before = await counts(db, sellerId);

    // Corrupt the payment state so revalidation fails.
    await db.run(`UPDATE payments SET version = version + 5 WHERE id = ?`, [paymentId]);

    await expect(postLedgerUpdate(db, APPROVER, proposal.id)).rejects.toThrowError(
      LedgerError,
    );

    const after = await counts(db, sellerId);
    expect(after.audit).toBe(before.audit);
  });

  it('refuses to create an adjustment with no account mapping', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(createAdjustment(db, BOOKKEEPER, {
        seller_id: sellerId,
        amount_cents: 1000,
        direction: 'debit',
        mapping_key: 'not_a_configured_key',
        memo: 'bad mapping',
      }),).rejects.toThrowError(/no account mapping configured/);
  });

  it('refuses an adjustment the creator tries to approve themselves', async () => {
    const { db, sellerId } = await makeTestDb();
    const adjustment = await createAdjustment(db, OWNER, {
      seller_id: sellerId,
      amount_cents: 1000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'self approved?',
    });

    await expect(approveAdjustment(db, OWNER, sellerId, adjustment.id)).rejects.toThrowError(
      /cannot be approved by the actor that created it/,
    );
  });

  it('keeps account balances at zero before any posting', async () => {
    const { db, sellerId } = await makeTestDb();
    const balances = await accountBalances(db, sellerId);
    expect(balances.every((b) => b.net_cents === 0)).toBe(true);
  });
});
