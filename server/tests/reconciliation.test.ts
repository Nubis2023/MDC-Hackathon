/**
 * The reconciliation interface.
 *
 * Covers the requirement that the interface shows the proposed entries,
 * affected invoices, balance changes and supporting records, and that it
 * detects drift rather than hiding it.
 */

import { describe, expect, it } from 'vitest';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
} from '../src/services/ledger';
import {
  accountBalances,
  reconcileSeller,
} from '../src/services/reconciliation';
import { deriveInvoiceState } from '../src/services/invoices';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  makeTestDb,
  allocatePayment,
  issueInvoice,
  recordPayment,
} from './helpers';

describe('reconciliation interface', () => {
  it('shows proposed debit and credit entries in the preview', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-PREVIEW');

    const preview = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
    }).preview;

    expect(preview.lines).toHaveLength(2);
    const debit = preview.lines.find((l) => l.side === 'debit')!;
    const credit = preview.lines.find((l) => l.side === 'credit')!;
    expect(debit.amount_cents).toBe(40000);
    expect(credit.amount_cents).toBe(40000);
    expect(preview.total_debit_cents).toBe(preview.total_credit_cents);
    expect(preview.balanced).toBe(true);
  });

  it('shows the affected invoice and its balance change', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-BALCHANGE');

    const preview = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
    }).preview;

    expect(preview.affected_invoices).toHaveLength(1);
    const change = preview.affected_invoices[0]!;
    expect(change.invoice_id).toBe(invoiceId);
    expect(change.balance_before_cents).toBe(100000);
    expect(change.balance_after_cents).toBe(60000);
    expect(change.applied_cents).toBe(40000);
  });

  it('shows the supporting source records', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-SUPPORT');

    const preview = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
    }).preview;

    const types = preview.supporting_records.map((r) => r.entity_type);
    expect(types).toContain('invoice');
    expect(types).toContain('payment');
  });

  it('reports a clean reconciliation for a consistent ledger', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-CLEAN');
    allocatePayment(db, sellerId, paymentId, invoiceId, 60000);

    const { summary, rows } = reconcileSeller(db, sellerId);
    expect(summary.drifted_count).toBe(0);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.trial_balance_cents).toBe(0);
    expect(rows.every((r) => r.reconciled)).toBe(true);
    // inv_1 is 100000 and had 60000 allocated, so 40000 remains; inv_2 is
    // untouched at 50000. Outstanding is therefore 90000.
    expect(summary.total_outstanding_cents).toBe(90000);
    expect(summary.total_allocated_cents).toBe(60000);
  });

  it('links each allocation back to its journal entry', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-TRACE');
    const entryId = allocatePayment(db, sellerId, paymentId, invoiceId, 60000);

    const { rows } = reconcileSeller(db, sellerId);
    const row = rows.find((r) => r.invoice.id === invoiceId)!;
    expect(row.allocations).toHaveLength(1);
    expect(row.allocations[0]!.journal_entry_id).toBe(entryId);
    expect(row.allocations[0]!.status).toBe('active');
  });

  it('detects drift when the cached balance is tampered with', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-DRIFT');
    allocatePayment(db, sellerId, paymentId, invoiceId, 60000);

    // Simulate a code path that moved the cached balance without going
    // through the allocation ledger.
    db.prepare(`UPDATE invoices SET balance_cents = 12345 WHERE id = ?`).run(
      invoiceId,
    );

    const { summary, rows } = reconcileSeller(db, sellerId);
    expect(summary.drifted_count).toBeGreaterThan(0);
    const row = rows.find((r) => r.invoice.id === invoiceId)!;
    expect(row.reconciled).toBe(false);
    expect(row.drift_cents).not.toBe(0);

    const drift = summary.drift.find((d) => d.entity_id === invoiceId)!;
    expect(drift.kind).toBe('invoice_balance');
    expect(drift.actual_cents).toBe(12345);
  });

  it('detects drift in a payment\'s cached unallocated amount', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-PDRIFT');
    allocatePayment(db, sellerId, paymentId, invoiceId, 60000);

    db.prepare(`UPDATE payments SET unallocated_cents = 999 WHERE id = ?`).run(
      paymentId,
    );

    const { summary } = reconcileSeller(db, sellerId);
    const drift = summary.drift.find((d) => d.entity_type === 'payment');
    expect(drift).toBeDefined();
    expect(drift!.kind).toBe('payment_unallocated');
    expect(drift!.diff_cents).toBe(999);
  });

  it('flags an over-settled invoice rather than clamping it', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    // Two payments each covering the full invoice, both allocated.
    const p1 = recordPayment(db, sellerId, 100000, 'REF-OVER-A');
    const p2 = recordPayment(db, sellerId, 100000, 'REF-OVER-B');
    allocatePayment(db, sellerId, p1, invoiceId, 100000);

    // The second allocation is refused at propose time because the invoice is
    // settled; force the over-settlement directly to prove the interface
    // catches it if it ever occurs.
    db.prepare(
      `INSERT INTO payment_allocations
         (id, seller_id, payment_id, invoice_id, amount_cents, status)
       VALUES ('alloc_forced', ?, ?, ?, 50000, 'active')`,
    ).run(sellerId, p2, invoiceId);

    const { summary } = reconcileSeller(db, sellerId);
    expect(
      summary.drift.some((d) => d.kind === 'oversettled_invoice'),
    ).toBe(true);
    expect(deriveInvoiceState(db, invoiceId).balance_cents).toBe(-50000);
  });

  it('shows reminder state alongside each invoice', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 100000, 'REF-REM');
    allocatePayment(db, sellerId, paymentId, invoiceId, 100000);

    const { rows } = reconcileSeller(db, sellerId);
    const row = rows.find((r) => r.invoice.id === invoiceId)!;
    expect(row.reminders.length).toBeGreaterThan(0);
    expect(row.reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('reports account balances that net to zero across the ledger', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 60000, 'REF-ACCT');
    allocatePayment(db, sellerId, paymentId, invoiceId, 60000);

    const balances = accountBalances(db, sellerId);
    const net = balances.reduce((sum, b) => sum + b.net_cents, 0);
    expect(net).toBe(0);

    // AR: debited 100000 on issue, credited 60000 on allocation.
    const ar = balances.find((b) => b.code === '1100')!;
    expect(ar.net_cents).toBe(40000);
    // Revenue: credited 100000.
    const revenue = balances.find((b) => b.code === '4000')!;
    expect(revenue.net_cents).toBe(-100000);
    // Cash: debited 60000.
    const cash = balances.find((b) => b.code === '1000')!;
    expect(cash.net_cents).toBe(60000);
  });

  it('excludes reversed entries from account balances', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    const entryId = issueInvoice(db, sellerId, invoiceId);

    const before = accountBalances(db, sellerId).find((b) => b.code === '1100')!;
    expect(before.net_cents).toBe(100000);

    reverseLedgerEntry(db, APPROVER, entryId, 'issued in error');

    const after = accountBalances(db, sellerId).find((b) => b.code === '1100')!;
    expect(after.net_cents).toBe(0);
  });

  it('surfaces unapplied cash separately from outstanding AR', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    recordPayment(db, sellerId, 60000, 'REF-UNAPPLIED');

    const { summary } = reconcileSeller(db, sellerId);
    // Money received but not applied to any invoice.
    expect(summary.total_unapplied_cash_cents).toBe(60000);
    // And the invoice is still fully outstanding.
    expect(summary.total_outstanding_cents).toBe(150000);
  });

  it('stays consistent after a full issue-pay-allocate cycle', () => {
    const { db, sellerId, invoiceId, otherInvoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    issueInvoice(db, sellerId, otherInvoiceId);
    const p1 = recordPayment(db, sellerId, 100000, 'REF-CYCLE-A');
    allocatePayment(db, sellerId, p1, invoiceId, 100000);

    const { summary, rows } = reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
    expect(rows.find((r) => r.invoice.id === invoiceId)!.invoice.status).toBe('paid');
    expect(rows.find((r) => r.invoice.id === otherInvoiceId)!.invoice.status).toBe(
      'open',
    );
  });

  it('reports the authoritative system on the summary', () => {
    const { db, sellerId } = makeTestDb({ authoritativeSystem: 'external' });
    const { summary } = reconcileSeller(db, sellerId);
    expect(summary.authoritative_system).toBe('external');
  });

  it('records the expected state needed to revalidate at post time', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const paymentId = recordPayment(db, sellerId, 40000, 'REF-EXPECTED');

    const proposal = proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: paymentId,
      invoice_id: invoiceId,
      amount_cents: 40000,
    });

    expect(proposal.expected.payment_id).toBe(paymentId);
    expect(proposal.expected.payment_version).toBeGreaterThan(0);
    expect(proposal.expected.payment_unallocated_cents).toBe(40000);
    expect(proposal.expected.invoices).toHaveLength(1);
    expect(proposal.expected.invoices[0]!.balance_cents).toBe(100000);
  });

  it('keeps the reconciliation readable after a credit note', () => {
    const { db, sellerId, invoiceId } = makeTestDb();
    issueInvoice(db, sellerId, invoiceId);
    const proposal = proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'apply_credit_note',
      seller_id: sellerId,
      invoice_id: invoiceId,
      amount_cents: 30000,
      reason: 'damaged goods',
    });
    approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    postLedgerUpdate(db, APPROVER, proposal.id);

    const { summary, rows } = reconcileSeller(db, sellerId);
    expect(summary.drifted_count).toBe(0);
    const row = rows.find((r) => r.invoice.id === invoiceId)!;
    expect(row.expected_balance_cents).toBe(70000);
    expect(row.invoice.balance_cents).toBe(70000);
  });
});
