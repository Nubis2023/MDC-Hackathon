/**
 * Reminder suppression after settlement.
 *
 * Covers the requirement to test reminder suppression after settlement: once
 * an invoice is settled, its outstanding reminders must be excluded, and if
 * the invoice is un-settled (a refund, or a reversed allocation) they must
 * come back.
 */

import { describe, expect, it } from 'vitest';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
} from '../src/services/ledger';
import { deriveInvoiceState } from '../src/services/invoices';
import {
  listOutstandingReminders,
  listRemindersForInvoice,
} from '../src/services/reminders';
import {
  approveAdjustment,
  createAdjustment,
} from '../src/services/adjustments';
import { listAuditEvents } from '../src/services/audit';
import { MAPPING_KEYS } from '../src/domain/types';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  makeTestDb,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

describe('reminder suppression after settlement', async () => {
  it('schedules the reminder ladder when an invoice is created', async () => {
    const { db, invoiceId } = await makeTestDb();
    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders).toHaveLength(3);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect(reminders.map((r) => r.kind).sort()).toEqual([
      'due_soon',
      'final_notice',
      'overdue',
    ]);
  });

  it('suppresses reminders when the invoice is fully settled', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-SETTLE');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect((await deriveInvoiceState(db, invoiceId)).status).toBe('paid');

    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
    expect(
      reminders.every((r) => r.suppressed_reason === 'invoice_settled'),
    ).toBe(true);
  });

  it('excludes a settled invoice from outstanding reminders', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-OUTSTANDING');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const outstanding = await listOutstandingReminders(db, sellerId);
    expect(outstanding.some((r) => r.invoice_id === invoiceId)).toBe(false);
  });

  it('keeps reminders scheduled while the invoice is only partly paid', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 40000, 'REF-PARTIAL');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(60000);
    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
  });

  it('suppresses reminders when a credit note settles the invoice', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'apply_credit_note',
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 100000,
      reason: 'full credit',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, proposal.id);

    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('suppresses reminders when an approved write-off settles the invoice', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    const adjustment = await createAdjustment(db, BOOKKEEPER, {
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 100000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'uncollectable write-off',
    });
    await approveAdjustment(db, APPROVER, sellerId, adjustment.id);

    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'post_adjustment',
      seller_id: sellerId,
      adjustment_id: adjustment.id,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, proposal.id);

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(0);
    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('reinstates reminders when a refund un-settles the invoice', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-REFUND');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    // Refund part of the payment against the invoice: it is now outstanding.
    // Proposed by a different actor than the approver, since one actor may
    // never approve its own proposal.
    const refundProposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_refund',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 30000,
      reason: 'returned goods',
    });
    await approveLedgerUpdate(db, APPROVER, refundProposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, refundProposal.id);

    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(30000);
    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect(reminders.every((r) => r.suppressed_reason === null)).toBe(true);
  });

  it('reinstates reminders when the settling allocation is reversed', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-REV-REMIND');
    const allocEntry = await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    await reverseLedgerEntry(db, APPROVER, allocEntry, 'applied to the wrong invoice');

    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect((await listOutstandingReminders(db, sellerId)).some((r) => r.invoice_id === invoiceId)).toBe(
      true,
    );
  });

  it('suppresses reminders when the invoice is voided by reversing its issuance', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    const entryId = await issueInvoice(db, sellerId, invoiceId);

    await reverseLedgerEntry(db, APPROVER, entryId, 'invoice raised in error');

    const reminders = await listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
    expect(
      reminders.every((r) => r.suppressed_reason === 'invoice_voided'),
    ).toBe(true);
  });

  it('records the reminder recheck in the audit trail', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-AUDIT-REM');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const actions = (await listAuditEvents(db, sellerId)).map((e) => e.action);
    expect(actions).toContain('reminders.rechecked');
  });

  it('does not resurrect a reminder that was already sent', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);

    // Mark one reminder as already sent.
    await db.run(
      `UPDATE reminders SET status = 'sent' WHERE invoice_id = ? AND kind = 'due_soon'`, [invoiceId]);

    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-SENT');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const reminders = await listRemindersForInvoice(db, invoiceId);
    const sent = reminders.find((r) => r.kind === 'due_soon')!;
    // A sent reminder stays sent: it happened, and history is not rewritten.
    expect(sent.status).toBe('sent');
    expect(
      reminders.filter((r) => r.kind !== 'due_soon').every((r) => r.status === 'suppressed'),
    ).toBe(true);
  });

  it('leaves other invoices\' reminders alone', async () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    await issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-ISOLATE');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    // The settled invoice's reminders are suppressed; the other invoice's are
    // untouched.
    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'suppressed'),
    ).toBe(true);
    expect(
      (await listRemindersForInvoice(db, otherInvoiceId)).every((r) => r.status === 'scheduled'),
    ).toBe(true);
  });

  it('suppresses reminders for a payment recorded but not yet allocated', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    // Money received but unapplied: the invoice is still outstanding, so its
    // reminders must stay scheduled.
    await recordPayment(db, sellerId, 100000, 'REF-UNAPPLIED');

    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'scheduled'),
    ).toBe(true);
    expect((await deriveInvoiceState(db, invoiceId)).balance_cents).toBe(100000);
  });

  it('suppresses in both directions across a settle/refund/re-settle cycle', async () => {
    const { db, sellerId, invoiceId } = await makeTestDb();
    await issueInvoice(db, sellerId, invoiceId);
    const paymentId = await recordPayment(db, sellerId, 100000, 'REF-CYCLE');
    await allocatePayment(db, sellerId, paymentId, invoiceId, 100000);
    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    // Refund 40%: outstanding again.
    const refund = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_refund',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
      reason: 'partial return',
    });
    await approveLedgerUpdate(db, APPROVER, refund.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, refund.id);
    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'scheduled'),
    ).toBe(true);

    // Re-settle with a second payment from the remaining unallocated amount.
    const topUp = await recordPayment(db, sellerId, 40000, 'REF-CYCLE-2');
    await allocatePayment(db, sellerId, topUp, invoiceId, 40000);
    expect(
      (await listRemindersForInvoice(db, invoiceId)).every((r) => r.status === 'suppressed'),
    ).toBe(true);
  });
});
