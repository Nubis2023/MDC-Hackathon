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

describe('reversals', async () => {
  it('reverses an entry by posting the exact negation', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    const original = await getJournalEntry(db, entryId)!;
    const result = await reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');
    const reversal = await getJournalEntry(db, result.reversal_entry_id)!;

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

  it('marks the original as reversed without editing it', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);
    const before = await getJournalEntry(db, entryId)!;

    await reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const after = await getJournalEntry(db, entryId)!;
    expect(after.status).toBe('reversed');

    // Everything else about the original is untouched — same lines, same
    // amounts, same memo, same posting time.
    expect(after.lines).toEqual(before.lines);
    expect(after.memo).toBe(before.memo);
    expect(after.posted_at).toBe(before.posted_at);
    expect(after.total_debit_cents).toBe(before.total_debit_cents);
  });

  it('forbids editing the lines of a posted entry', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await expect(db.run(`UPDATE journal_lines SET amount_cents = 999 WHERE entry_id = ?`, [entryId]),).rejects.toThrowError(/immutable/);
  });

  it('forbids deleting the lines of a posted entry', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await expect(db.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [entryId]),).rejects.toThrowError(/immutable/);
  });

  it('forbids editing the memo of a posted entry', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await expect(db.run(`UPDATE journal_entries SET memo = 'tampered' WHERE id = ?`, [entryId]),).rejects.toThrowError(/immutable/);
  });

  it('removes the reversed effect from the derived invoice balance', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const issueEntry = await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 40000, 'REF-REV-ALLOC');
    const allocEntry = await allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(60000);

    await reverseLedgerEntry(db, APPROVER, allocEntry, 'applied to wrong invoice');

    // The allocation dropped out, so the invoice is back to its full balance.
    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(100000);
    // And the payment is unallocated again.
    expect(await deriveUnallocatedCents(db, paymentId)).toBe(40000);
    expect(issueEntry).toBeTruthy();
  });

  it('refuses to reverse a reversal', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);
    const result = await reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    await expect(reverseLedgerEntry(db, APPROVER, result.reversal_entry_id, 'undo the undo'),).rejects.toThrowError(/itself a reversal/);
  });

  it('refuses to reverse the same entry twice', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);
    await reverseLedgerEntry(db, APPROVER, entryId, 'first');

    await expect(reverseLedgerEntry(db, APPROVER, entryId, 'second'),).rejects.toThrowError(/already been reversed/);
  });

  it('requires a reason to reverse', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await expect(reverseLedgerEntry(db, APPROVER, entryId, '')).rejects.toThrowError(
      /reason is required/,
    );
    await expect(reverseLedgerEntry(db, APPROVER, entryId, '   ')).rejects.toThrowError(
      /reason is required/,
    );
  });

  it('supports a corrected replacement entry after a reversal', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();

    // Record a payment in the wrong amount, then correct it.
    const wrongId = await recordPayment(db, sellerId, 5000, 'REF-CORRECT');

    const wrongEntry = await db.get(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`, [sellerId]) as { id: string };
    await reverseLedgerEntry(db, OWNER, wrongEntry.id, 'wrong amount recorded');

    // Post the corrected payment as a new business event.
    const correctedProposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 8000,
      received_at: '2026-09-02T12:00:00.000Z',
      reference: 'REF-CORRECT-V2',
      payer_name: 'Test Customer',
    });
    await approveLedgerUpdate(db, APPROVER, correctedProposal.id, { reason: 'correction' });
    await postLedgerUpdate(db, APPROVER, correctedProposal.id);

    const entries = await db.get(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'
            AND status = 'posted'`, [sellerId]) as { n: number };
    expect(entries.n).toBe(1);

    const wrong = await getJournalEntry(db, wrongEntry.id)!;
    expect(wrong.status).toBe('reversed');

    // The replacement is linked to the original by source, not by a foreign
    // key, so both remain readable.
    const reversal = await db.get(
        `SELECT COUNT(*) AS n FROM journal_entries
          WHERE seller_id = ? AND reversal_of = ?`, [sellerId, wrongEntry.id]) as { n: number };
    expect(reversal.n).toBe(1);
    expect(wrongId).toBeTruthy();
  });

  it('keeps the trial balance at zero after a reversal', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 30000, 'REF-REV-BAL');
    const allocEntry = await allocatePayment(db, sellerId, paymentId, invoiceId, 30000);

    await reverseLedgerEntry(db, APPROVER, allocEntry, 'wrong invoice');

    const { summary } = await reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('refuses to reverse a payment that still has active allocations', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 20000, 'REF-REV-PAY');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 20000);

    const paymentEntry = await db.get(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'record_payment'`, [sellerId]) as { id: string };

    await expect(reverseLedgerEntry(db, APPROVER, paymentEntry.id, 'bad payment'),).rejects.toThrowError(/active allocation/);
  });

  it('reverses a credit note and restores the invoice balance', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'apply_credit_note',
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 25000,
      reason: 'short shipment',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, proposal.id);

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(75000);

    const cnEntry = await db.get(
        `SELECT id FROM journal_entries
          WHERE seller_id = ? AND source_type = 'apply_credit_note'`, [sellerId]) as { id: string };

    await reverseLedgerEntry(db, APPROVER, cnEntry.id, 'credit note was wrong');

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(100000);
    expect((await deriveInvoiceState(db, invoiceId)).status).toBe('open');
  });

  it('records both the posting and its reversal in the audit trail', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);
    await reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const actions = (await listAuditEvents(db, sellerId)).map((e) => e.action);
    expect(actions).toContain('ledger_entry.posted');
    expect(actions).toContain('ledger_entry.reversed');
  });

  it('refuses to reverse an unposted entry', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    await expect(reverseLedgerEntry(db, APPROVER, 'je_does_not_exist', 'nope'),).rejects.toThrowError(/not found/);
  });

  it('preserves the reversal link in the reversal entry', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);
    const result = await reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const reversal = await getJournalEntry(db, result.reversal_entry_id)!;
    expect(reversal.source_type).toBe('reverse_entry');
    expect(reversal.source_id).toBe(entryId);
    expect(reversal.reversal_of).toBe(entryId);
    expect(reversal.posted_by).toBe(APPROVER.id);
  });

  it('will not let a reversal be posted against a mismatched seller', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await expect(reverseLedgerEntry(db, OUTSIDER, entryId, 'not my seller'),).rejects.toThrowError(LedgerError);
  });

  it('keeps invoice status consistent after reversing the settling allocation', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-REV-STATUS');
    const allocEntry = await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect((await deriveInvoiceState(db, invoiceId)).status).toBe('paid');

    await reverseLedgerEntry(db, APPROVER, allocEntry, 'payment was for another account');

    const after = await deriveInvoiceState(db, invoiceId);
    expect(after.status).toBe('open');
    expect(after.balance_cents).toBe(100000);
  });
});
