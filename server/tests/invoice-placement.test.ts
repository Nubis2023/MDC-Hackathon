/**
 * Placing an invoice, and posting its receivable.
 *
 * Two distinct steps, tested separately on purpose:
 *
 *   createInvoice()  writes the subledger document and its reminder ladder.
 *                    It does NOT touch the ledger.
 *   issue_invoice    puts the receivable on the books, through the normal
 *                    propose -> approve -> post flow.
 *
 * Keeping them apart is what makes the accounting entry reviewable rather than
 * a side effect of creating a document.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import { createInvoice, deriveInvoiceState } from '../src/services/invoices';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
} from '../src/services/ledger';
import { listRemindersForInvoice } from '../src/services/reminders';
import { listAuditEvents } from '../src/services/audit';
import { accountBalances, reconcileSeller } from '../src/services/reconciliation';
import { AGENT, APPROVER, BOOKKEEPER, OUTSIDER, makeTestDb } from './helpers';

const VALID = {
  customer_name: 'Harbor Logistics',
  number: 'INV-9001',
  issue_date: '2026-09-01',
  due_date: '2026-10-01',
  subtotal_cents: 125000,
  tax_cents: 10000,
};

describe('placing an invoice', () => {
  it('creates the document with the total derived from net and tax', async () => {
    const { db, sellerId } = await makeTestDb();
    const invoice = await createInvoice(db, BOOKKEEPER, {
      ...VALID,
      seller_id: sellerId,
    });

    expect(invoice.number).toBe('INV-9001');
    expect(invoice.customer_name).toBe('Harbor Logistics');
    expect(invoice.subtotal_cents).toBe(125000);
    expect(invoice.tax_cents).toBe(10000);
    expect(invoice.total_cents).toBe(135000);
    // An unissued invoice is fully outstanding.
    expect(invoice.balance_cents).toBe(135000);
    expect(invoice.status).toBe('open');
  });

  it('does not touch the ledger', async () => {
    const { db, sellerId } = await makeTestDb();
    await createInvoice(db, BOOKKEEPER, { ...VALID, seller_id: sellerId });

    const entries = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_entries WHERE seller_id = ?`,
      [sellerId],
    );
    expect(entries?.n).toBe(0);

    // No receivable exists until it is posted, so AR must still be zero.
    const balances = await accountBalances(db, sellerId);
    const ar = balances.find((b) => b.code === '1100');
    expect(ar?.net_cents).toBe(0);
  });

  it('schedules the reminder ladder immediately', async () => {
    const { db, sellerId } = await makeTestDb();
    const invoice = await createInvoice(db, BOOKKEEPER, {
      ...VALID,
      seller_id: sellerId,
    });

    const reminders = await listRemindersForInvoice(db, invoice.id);
    expect(reminders).toHaveLength(3);
    expect(reminders.every((r) => r.status === 'scheduled')).toBe(true);
  });

  it('writes an audit event for the creation', async () => {
    const { db, sellerId } = await makeTestDb();
    await createInvoice(db, BOOKKEEPER, { ...VALID, seller_id: sellerId });

    const actions = (await listAuditEvents(db, sellerId)).map((e) => e.action);
    expect(actions).toContain('invoice.created');
  });

  it('defaults tax to zero when omitted', async () => {
    const { db, sellerId } = await makeTestDb();
    const invoice = await createInvoice(db, BOOKKEEPER, {
      seller_id: sellerId,
      customer_name: VALID.customer_name,
      number: VALID.number,
      issue_date: VALID.issue_date,
      due_date: VALID.due_date,
      subtotal_cents: VALID.subtotal_cents,
    });
    expect(invoice.tax_cents).toBe(0);
    expect(invoice.total_cents).toBe(125000);
  });

  it('rejects a duplicate invoice number for the same seller', async () => {
    const { db, sellerId } = await makeTestDb();
    await createInvoice(db, BOOKKEEPER, { ...VALID, seller_id: sellerId });

    await expect(
      createInvoice(db, BOOKKEEPER, { ...VALID, seller_id: sellerId }),
    ).rejects.toThrowError(/already exists/);
  });

  it('allows the same number for a different seller', async () => {
    const { db, sellerId } = await makeTestDb();
    await createInvoice(db, BOOKKEEPER, { ...VALID, seller_id: sellerId });

    // The unique constraint is per seller, so this must succeed.
    const other = await createInvoice(db, BOOKKEEPER, {
      ...VALID,
      seller_id: 'seller_other',
    });
    expect(other.id).toBeTruthy();
  });

  it('refuses a due date before the issue date', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        issue_date: '2026-10-01',
        due_date: '2026-09-01',
      }),
    ).rejects.toThrowError(/cannot be earlier/);
  });

  it('refuses a zero total', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        subtotal_cents: 0,
        tax_cents: 0,
      }),
    ).rejects.toThrowError(/more than zero/);
  });

  it('refuses a negative or non-integer amount', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        subtotal_cents: -100,
      }),
    ).rejects.toThrowError(/non-negative integer/);

    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        subtotal_cents: 100.5,
      }),
    ).rejects.toThrowError(/non-negative integer/);
  });

  it('refuses a malformed date', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        issue_date: '01/09/2026',
      }),
    ).rejects.toThrowError(/YYYY-MM-DD/);
  });

  it('refuses an empty customer or number', async () => {
    const { db, sellerId } = await makeTestDb();
    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        customer_name: '   ',
      }),
    ).rejects.toThrowError(/customer_name is required/);

    await expect(
      createInvoice(db, BOOKKEEPER, {
        ...VALID,
        seller_id: sellerId,
        number: '',
      }),
    ).rejects.toThrowError(/number is required/);
  });
});

describe('posting an invoice placed through createInvoice', () => {
  /** Place an invoice and post its receivable, returning both. */
  async function placeAndIssue(
    db: Awaited<ReturnType<typeof makeTestDb>>['db'],
    sellerId: string,
  ) {
    const invoice = await createInvoice(db, BOOKKEEPER, {
      ...VALID,
      seller_id: sellerId,
    });
    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'issue_invoice',
      seller_id: sellerId,
      invoice_id: invoice.id,
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const posted = await postLedgerUpdate(db, APPROVER, proposal.id);
    return { invoice, proposal, posted };
  }

  it('posts a balanced entry and puts the receivable on the books', async () => {
    const { db, sellerId } = await makeTestDb();
    const { invoice, posted } = await placeAndIssue(db, sellerId);

    const lines = await db.all<{ amount_cents: number }>(
      `SELECT amount_cents FROM journal_lines WHERE entry_id = ?`,
      [posted.entry_id],
    );
    const total = lines.reduce((s, l) => s + Number(l.amount_cents), 0);
    expect(total).toBe(0);

    // DR accounts receivable for the gross, CR revenue for the net.
    const balances = await accountBalances(db, sellerId);
    expect(balances.find((b) => b.code === '1100')?.net_cents).toBe(135000);
    expect(balances.find((b) => b.code === '4000')?.net_cents).toBe(-125000);
    expect(balances.find((b) => b.code === '2200')?.net_cents).toBe(-10000);

    // The document agrees with the entry.
    const derived = await deriveInvoiceState(db, invoice.id);
    expect(derived.balance_cents).toBe(135000);
    expect(derived.status).toBe('open');
  });

  it('refuses to post the same invoice twice', async () => {
    const { db, sellerId } = await makeTestDb();
    const { invoice } = await placeAndIssue(db, sellerId);

    // A second issuance of the same invoice is refused, so revenue cannot be
    // recognised twice for one document.
    await expect(
      proposeLedgerUpdate(db, BOOKKEEPER, {
        kind: 'issue_invoice',
        seller_id: sellerId,
        invoice_id: invoice.id,
      }),
    ).rejects.toThrowError(/already been issued/);
  });

  it('keeps the reconciliation clean after placing and issuing', async () => {
    const { db, sellerId } = await makeTestDb();
    await placeAndIssue(db, sellerId);

    const { summary } = await reconcileSeller(db, sellerId);
    expect(summary.trial_balanced).toBe(true);
    expect(summary.drifted_count).toBe(0);
  });

  it('allows a payment to settle an invoice placed through createInvoice', async () => {
    const { db, sellerId } = await makeTestDb();
    const { invoice } = await placeAndIssue(db, sellerId);

    const payProposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 135000,
      received_at: '2026-09-15T12:00:00.000Z',
      reference: 'REF-NEW-INV',
      payer_name: 'Harbor Logistics',
    });
    await approveLedgerUpdate(db, APPROVER, payProposal.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, payProposal.id);

    const payment = await db.get<{ id: string }>(
      `SELECT id FROM payments WHERE reference = ?`,
      ['REF-NEW-INV'],
    );
    const alloc = await proposeLedgerUpdate(db, AGENT, {
      kind: 'allocate_payment',
      seller_id: sellerId,
      payment_id: payment!.id,
      invoice_id: invoice.id,
      amount_cents: 135000,
    });
    await approveLedgerUpdate(db, APPROVER, alloc.id, { reason: 'test' });
    await postLedgerUpdate(db, APPROVER, alloc.id);

    const derived = await deriveInvoiceState(db, invoice.id);
    expect(derived.balance_cents).toBe(0);
    expect(derived.status).toBe('paid');

    // Settling it must suppress the reminders that were scheduled at creation.
    const reminders = await listRemindersForInvoice(db, invoice.id);
    expect(reminders.every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('refuses an issuance proposed against another seller\'s invoice', async () => {
    const { db, sellerId } = await makeTestDb();
    const invoice = await createInvoice(db, BOOKKEEPER, {
      ...VALID,
      seller_id: sellerId,
    });

    // OUTSIDER belongs to the other seller only.
    await expect(
      proposeLedgerUpdate(db, OUTSIDER, {
        kind: 'issue_invoice',
        seller_id: sellerId,
        invoice_id: invoice.id,
      }),
    ).rejects.toThrowError(LedgerError);
  });
});
