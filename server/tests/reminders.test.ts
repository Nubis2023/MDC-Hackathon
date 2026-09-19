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

describe('reminder suppression after settlement', () => {
  it('schedules the reminder ladder when an invoice is created', () => {
    const { db, invoiceId } = makeTestDb();
    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders).toHaveLength(3);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect(reminders.map((r) => r.kind).sort()).toEqual([
      'due_soon',
      'final_notice',
      'overdue',
    ]);
  });

  it('suppresses reminders when the invoice is fully settled', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-SETTLE');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(deriveInvoiceState(db, invoiceId).status).toBe('paid');

    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
    expect(
      reminders.every((r) => r.suppressed_reason === 'invoice_settled'),
    ).toBe(true);
  });

  it('excludes a settled invoice from outstanding reminders', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-OUTSTANDING');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const outstanding = listOutstandingReminders(db, sellerId);
    expect(outstanding.some((r) => r.invoice_id === invoiceId)).toBe(false);
  });

  it('keeps reminders scheduled while the invoice is only partly paid', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-PARTIAL');
    allocatePayment(db, sellerId, paymentId, invoiceId, 40000);

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(60000);
    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
  });

  it('suppresses reminders when a credit note settles the invoice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    const proposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'apply_credit_note',
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 100000,
      reason: 'full credit',
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, proposal.id);

    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('suppresses reminders when an approved write-off settles the invoice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    const adjustment = createAdjustment(db, BOOKKEEPER, {
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 100000,
      direction: 'debit',
      mapping_key: MAPPING_KEYS.ADJUSTMENT,
      memo: 'uncollectable write-off',
    });
    approveAdjustment(db, APPROVER, sellerId, adjustment.id);

    const proposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'post_adjustment',
      seller_id: sellerId,
      adjustment_id: adjustment.id,
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, proposal.id);

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(0);
    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('reinstates reminders when a refund un-settles the invoice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-REFUND');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    // Refund part of the payment against the invoice: it is now outstanding.
    // Proposed by a different actor than the approver, since one actor may
    // never approve its own proposal.
    const refundProposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_refund',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 30000,
      reason: 'returned goods',
    });
    approveLedgerUpdate(db, APPROVER, refundProposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, refundProposal.id);

    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(30000);
    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect(reminders.every((r) => r.suppressed_reason === null)).toBe(true);
  });

  it('reinstates reminders when the settling allocation is reversed', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-REV-REMIND');
    const allocEntry = allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    reverseLedgerEntry(db, APPROVER, allocEntry, 'applied to the wrong invoice');

    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
    expect(listOutstandingReminders(db, sellerId).some((r) => r.invoice_id === invoiceId)).toBe(
      true,
    );
  });

  it('suppresses reminders when the invoice is voided by reversing its issuance', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    reverseLedgerEntry(db, APPROVER, entryId, 'invoice raised in error');

    const reminders = listRemindersForInvoice(db, invoiceId);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
    expect(
      reminders.every((r) => r.suppressed_reason === 'invoice_voided'),
    ).toBe(true);
  });

  it('records the reminder recheck in the audit trail', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-AUDIT-REM');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const actions = listAuditEvents(db, sellerId).map((e) => e.action);
    expect(actions).toContain('reminders.rechecked');
  });

  it('does not resurrect a reminder that was already sent', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);

    // Mark one reminder as already sent.
    db.prepare(
      `UPDATE reminders SET status = 'sent' WHERE invoice_id = ? AND kind = 'due_soon'`,
    ).run(invoiceId);

    const paymentId = recordPayment(db, sellerId, 100000, 'REF-SENT');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const reminders = listRemindersForInvoice(db, invoiceId);
    const sent = reminders.find((r) => r.kind === 'due_soon')!;
    // A sent reminder stays sent: it happened, and history is not rewritten.
    expect(sent.status).toBe('sent');
    expect(
      reminders.filter((r) => r.kind !== 'due_soon').every((r) => r.status === 'suppressed'),
    ).toBe(true);
  });

  it('leaves other invoices\' reminders alone', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-ISOLATE');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    // The settled invoice's reminders are suppressed; the other invoice's are
    // untouched.
    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'suppressed'),
    ).toBe(true);
    expect(
      listRemindersForInvoice(db, otherInvoiceId).every((r) => r.status === 'scheduled'),
    ).toBe(true);
  });

  it('suppresses reminders for a payment recorded but not yet allocated', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    // Money received but unapplied: the invoice is still outstanding, so its
    // reminders must stay scheduled.
    recordPayment(db, sellerId, 100000, 'REF-UNAPPLIED');

    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'scheduled'),
    ).toBe(true);
    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(100000);
  });

  it('suppresses in both directions across a settle/refund/re-settle cycle', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-CYCLE');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);
    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'suppressed'),
    ).toBe(true);

    // Refund 40%: outstanding again.
    const refund = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_refund',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
      reason: 'partial return',
    });
    approveLedgerUpdate(db, APPROVER, refund.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, refund.id);
    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'scheduled'),
    ).toBe(true);

    // Re-settle with a second payment from the remaining unallocated amount.
    const topUp = recordPayment(db, sellerId, 40000, 'REF-CYCLE-2');
    allocatePayment(db, sellerId, topUp, invoiceId, 40000);
    expect(
      listRemindersForInvoice(db, invoiceId).every((r) => r.status === 'suppressed'),
    ).toBe(true);
  });
});
