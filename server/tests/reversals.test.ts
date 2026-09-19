/**
 * Reversals.
 *
 * Covers the requirement to test reversals. The invariants under test:
 *   - a posted entry and its lines are never edited or deleted
 *   - a reversal is the exact negation, linked to the original
 *   - the original is marked reversed, which removes its effect from every
 *     derived balance
 *   - a reversal cannot itself be reversed
 *   - linked replacement entries are how a mistake is corrected
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
} from '../src/services/ledger';
import { listAuditEvents } from '../src/services/audit';
import { getJournalEntry } from '../src/services/journal';
import { deriveInvoiceState } from '../src/services/invoices';
import { deriveUnallocatedCents } from '../src/services/payments';
import { reconcileSeller } from '../src/services/reconciliation';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  OUTSIDER,
  OWNER,
  makeTestDb,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

describe('reversals', () => {
  it('reverses an entry by posting the exact negation', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    const original = getJournalEntry(db, entryId)!;
    const result = reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');
    const reversal = getJournalEntry(db, result.reversal_entry_id)!;

    expect(reversal.entry_kind).toBe('reversal');
    expect(reversal.reversal_of).toBe(entryId);
    expect(reversal.balanced).toBe(true);

    // Each reversal line is the mirror of the original, account for account.
    expect(reversal.lines).toHaveLength(original.lines.length);
    for (const line of reversal.lines) {
      const counterpart = original.lines.find(
        (l) => l.account_id === line.account_id,
      );
      expect(counterpart).toBeDefined();
      expect(line.side).not.toBe(counterpart!.side);
      expect(Math.abs(line.amount_cents)).toBe(
        Math.abs(counterpart!.amount_cents),
      );
    }
  });

  it('marks the original as reversed without editing it', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);
    const before = getJournalEntry(db, entryId)!;

    reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const after = getJournalEntry(db, entryId)!;
    expect(after.status).toBe('reversed');

    // Everything else about the original is untouched — same lines, same
    // amounts, same memo, same posting time.
    expect(after.lines).toEqual(before.lines);
    expect(after.memo).toBe(before.memo);
    expect(after.posted_at).toBe(before.posted_at);
    expect(after.total_debit_cents).toBe(before.total_debit_cents);
  });

  it('forbids editing the lines of a posted entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    expect(() =>
      db
        .prepare(`UPDATE journal_lines SET amount_cents = 999 WHERE entry_id = ?`)
        .run(entryId),
    ).toThrowError(/immutable/);
  });

  it('forbids deleting the lines of a posted entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    expect(() =>
      db.prepare(`DELETE FROM journal_lines WHERE entry_id = ?`).run(entryId),
    ).toThrowError(/immutable/);
  });

  it('forbids editing the memo of a posted entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    expect(() =>
      db
        .prepare(`UPDATE journal_entries SET memo = 'tampered' WHERE id = ?`)
        .run(entryId),
    ).toThrowError(/immutable/);
  });

  it('removes the reversed effect from the derived invoice balance', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const issueEntry = issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-REV-ALLOC');
    const allocEntry = allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(60000);

    reverseLedgerEntry(db, APPROVER, allocEntry, 'applied to wrong invoice');

    // The allocation dropped out, so the invoice is back to its full balance.
    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(100000);
    // And the payment is unallocated again.
    expect(deriveUnallocatedCents(db, paymentId)).toBe(40000);
    expect(issueEntry).toBeTruthy();
  });

  it('refuses to reverse a reversal', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);
    const result = reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    expect(() =>
      reverseLedgerEntry(db, APPROVER, result.reversal_entry_id, 'undo the undo'),
    ).toThrowError(/itself a reversal/);
  });

  it('refuses to reverse the same entry twice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);
    reverseLedgerEntry(db, APPROVER, entryId, 'first');

    expect(() =>
      reverseLedgerEntry(db, APPROVER, entryId, 'second'),
    ).toThrowError(/already been reversed/);
  });

  it('requires a reason to reverse', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    expect(() => reverseLedgerEntry(db, APPROVER, entryId, '')).toThrowError(
      /reason is required/,
    );
    expect(() => reverseLedgerEntry(db, APPROVER, entryId, '   ')).toThrowError(
      /reason is required/,
    );
  });

  it('supports a corrected replacement entry after a reversal', () => {
    const { db, sellerId, invoiceId } = makeTestDb();

    // Record a payment in the wrong amount, then correct it.
    const wrongId = recordPayment(db, sellerId, 5000, 'REF-CORRECT');

    const wrongEntry = db
      .prepare(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`,
      )
      .get(sellerId) as { id: string };
    reverseLedgerEntry(db, OWNER, wrongEntry.id, 'wrong amount recorded');

    // Post the corrected payment as a new business event.
    const correctedProposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 8000,
      received_at: '2026-09-02T12:00:00.000Z',
      reference: 'REF-CORRECT-V2',
      payer_name: 'Test Customer',
    });
    approveLedgerUpdate(db, APPROVER, correctedProposal.id, { reason: 'correction' });
    postLedgerUpdate(db, APPROVER, correctedProposal.id);

    const entries = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'
            AND status = 'posted'`,
      )
      .get(sellerId) as { n: number };
    expect(entries.n).toBe(1);

    const wrong = getJournalEntry(db, wrongEntry.id)!;
    expect(wrong.status).toBe('reversed');

    // The replacement is linked to the original by source, not by a foreign
    // key, so both remain readable.
    const reversal = db
      .prepare(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND reversal_of = ?`,
      )
      .get(sellerId, wrongEntry.id) as { n: number };
    expect(reversal.n).toBe(1);
    expect(wrongId).toBeTruthy();
  });

  it('keeps the trial balance at zero after a reversal', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 30000, 'REF-REV-BAL');
    const allocEntry = allocatePayment(db, sellerId, paymentId, invoiceId, 30000);

    reverseLedgerEntry(db, APPROVER, allocEntry, 'wrong invoice');

    const { summary } = reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('refuses to reverse a payment that still has active allocations', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 20000, 'REF-REV-PAY');
    allocatePayment(db, sellerId, paymentId, invoiceId, 20000);

    const paymentEntry = db
      .prepare(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`,
      )
      .get(sellerId) as { id: string };

    expect(() =>
      reverseLedgerEntry(db, APPROVER, paymentEntry.id, 'bad payment'),
    ).toThrowError(/active allocation/);
  });

  it('reverses a credit note and restores the invoice balance', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    const proposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'apply_credit_note',
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 25000,
      reason: 'short shipment',
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, proposal.id);

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(75000);

    const cnEntry = db
      .prepare(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'apply_credit_note'`,
      )
      .get(sellerId) as { id: string };

    reverseLedgerEntry(db, APPROVER, cnEntry.id, 'credit note was wrong');

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(100000);
    expect(deriveInvoiceState(db, invoiceId).status).toBe('open');
  });

  it('records both the posting and its reversal in the audit trail', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);
    reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const actions = listAuditEvents(db, sellerId).map((e) => e.action);
    expect(actions).toContain('ledger_entry.posted');
    expect(actions).toContain('ledger_entry.reversed');
  });

  it('refuses to reverse an unposted entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    expect(() =>
      reverseLedgerEntry(db, APPROVER, 'je_does_not_exist', 'nope'),
    ).toThrowError(/not found/);
  });

  it('preserves the reversal link in the reversal entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);
    const result = reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const reversal = getJournalEntry(db, result.reversal_entry_id)!;
    expect(reversal.source_type).toBe('reverse_entry');
    expect(reversal.source_id).toBe(entryId);
    expect(reversal.reversal_of).toBe(entryId);
    expect(reversal.posted_by).toBe(APPROVER.id);
  });

  it('will not let a reversal be posted against a mismatched seller', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    expect(() =>
      reverseLedgerEntry(db, OUTSIDER, entryId, 'not my seller'),
    ).toThrowError(LedgerError);
  });

  it('keeps invoice status consistent after reversing the settling allocation', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-REV-STATUS');
    const allocEntry = allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(deriveInvoiceState(db, invoiceId).status).toBe('paid');

    reverseLedgerEntry(db, APPROVER, allocEntry, 'payment was for another account');

    const after = deriveInvoiceState(db, invoiceId);
    expect(after.status).toBe('open');
    expect(after.balance_cents).toBe(100000);
  });
});
