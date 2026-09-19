/**
 * Operation planning — the single place each ledger operation's accounting
 * shape is defined.
 *
 * Everything else in the service is generic:
 *
 *   await planOperation()      validates the request against live state and
 *                        produces the proposed lines, the affected invoices,
 *                        the balance changes and the supporting records.
 *   posting (ledger.ts)  applies the planned effects and commits one
 *                        transaction.
 *   preview              is the plan rendered for a human.
 *   revalidation         re-runs await planOperation() at post time and compares.
 *
 * Because posting re-plans from the original operation rather than trusting
 * the stored preview, a proposal approved on Monday cannot commit stale
 * numbers on Friday — the second plan either agrees with the first or the
 * posting is refused.
 *
 * Accounting shapes (all built from configured account mappings, never
 * hardcoded account codes):
 *
 *   issue_invoice      DR accounts_receivable        total
 *                      CR revenue                    subtotal
 *                      CR tax_payable                tax
 *
 *   record_payment     DR cash                       amount
 *                      CR unapplied_cash             amount
 *
 *   allocate_payment   DR unapplied_cash             amount
 *                      CR accounts_receivable        amount
 *
 *   apply_credit_note  DR credit_note                amount
 *                      CR accounts_receivable        amount
 *
 *   record_fee         DR fee_expense                amount
 *                      CR cash                       amount
 *
 *   record_refund      DR refund_expense             amount
 *                      CR cash                       amount
 *
 *   post_adjustment    direction 'debit'  (write-off, reduces the invoice):
 *                      DR adjustment                 amount
 *                      CR accounts_receivable        amount
 *                      direction 'credit' (surcharge, increases it):
 *                      DR accounts_receivable        amount
 *                      CR adjustment                 amount
 */

import type { SqlDb } from '../db';
import { LedgerError } from '../domain/errors';
import { buildLines } from '../domain/mappings';
import type {
  ExpectedState,
  InvoiceBalanceChange,
  LedgerPreview,
  PostingSpec,
  ProposalKind,
  SupportingRecord,
} from '../domain/types';
import { MAPPING_KEYS } from '../domain/types';
import { deriveInvoiceState, requireInvoice, assertInvoiceAcceptingPayment } from './invoices';
import {
  assertPaymentAllocatable,
  deriveUnallocatedCents,
  requirePayment,
} from './payments';
import { deriveSourceEventId, deterministicId } from './ids';

// ───────────────────────────── operation inputs ─────────────────────────

export interface IssueInvoiceInput {
  kind: 'issue_invoice';
  seller_id: string;
  invoice_id: string;
  source_event_id?: string;
}

export interface RecordPaymentInput {
  kind: 'record_payment';
  seller_id: string;
  amount_cents: number;
  received_at: string;
  currency?: string;
  reference?: string | null;
  payer_name?: string | null;
  source_event_id?: string;
}

export interface AllocatePaymentInput {
  kind: 'allocate_payment';
  seller_id: string;
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
  source_event_id?: string;
}

export interface ApplyCreditNoteInput {
  kind: 'apply_credit_note';
  seller_id: string;
  invoice_id: string;
  amount_cents: number;
  reason?: string | null;
  source_event_id?: string;
}

export interface RecordFeeInput {
  kind: 'record_fee';
  seller_id: string;
  payment_id?: string | null;
  amount_cents: number;
  description: string;
  source_event_id?: string;
}

export interface RecordRefundInput {
  kind: 'record_refund';
  seller_id: string;
  payment_id: string;
  invoice_id?: string | null;
  amount_cents: number;
  reason?: string | null;
  source_event_id?: string;
}

export interface PostAdjustmentInput {
  kind: 'post_adjustment';
  seller_id: string;
  adjustment_id: string;
  source_event_id?: string;
}

export type OperationInput =
  | IssueInvoiceInput
  | RecordPaymentInput
  | AllocatePaymentInput
  | ApplyCreditNoteInput
  | RecordFeeInput
  | RecordRefundInput
  | PostAdjustmentInput;

// ─────────────────────────────── plan output ────────────────────────────

export interface PlanResult {
  proposal_kind: ProposalKind;
  source_type: string;
  source_id: string;
  source_event_id: string;
  memo: string;
  entry_date: string;
  preview: LedgerPreview;
  /** Semantic fields an exact-match auto-post rule may match against. */
  auto_fields: Record<string, unknown>;
  auto_amount_cents?: number;
}

/** Pure validation helper — stays synchronous so a throw propagates directly. */
function assertPositive(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new LedgerError(
      'validation',
      `${label} must be a positive integer number of cents`,
    );
  }
}

async function balanceChange(
  db: SqlDb,
  sellerId: string,
  invoiceId: string,
  appliedCents: number,
  memo: string,
): Promise<{
  change: InvoiceBalanceChange;
  supporting: SupportingRecord;
  expectedInvoice: ExpectedState['invoices'][number];
}>{
  const invoice = await requireInvoice(db, sellerId, invoiceId);
  const derived = await deriveInvoiceState(db, invoiceId);
  const change: InvoiceBalanceChange = {
    invoice_id: invoice.id,
    number: invoice.number,
    balance_before_cents: derived.balance_cents,
    balance_after_cents: derived.balance_cents - appliedCents,
    applied_cents: appliedCents,
  };
  return {
    change,
    supporting: {
      entity_type: 'invoice',
      entity_id: invoice.id,
      description: `${invoice.number} — ${invoice.customer_name} (${memo})`,
      amount_cents: appliedCents,
    },
    expectedInvoice: {
      invoice_id: invoice.id,
      version: invoice.version,
      balance_cents: derived.balance_cents,
      status: derived.status,
    },
  };
}

async function assemble(
  db: SqlDb,
  sellerId: string,
  kind: ProposalKind,
  memo: string,
  entryDate: string,
  specs: PostingSpec[],
  affected: InvoiceBalanceChange[],
  supporting: SupportingRecord[],
  expected: ExpectedState,
  /**
   * The id of the source entity this entry posts against (the invoice, the
   * payment, the allocation, ...). Distinct from source_event_id: the event id
   * is the duplicate-post key, while this is what a reversal resolves back to
   * in order to undo the subledger effect.
   */
  sourceId: string,
): Promise<PlanResult>{
  const built = await buildLines(db, sellerId, specs);
  const seller = await db.get(`SELECT currency FROM sellers WHERE id = ?`, [sellerId]) as { currency: string } | undefined;
  if (!seller) {
    throw new LedgerError('not_found', `seller '${sellerId}' not found`);
  }
  const preview: LedgerPreview = {
    proposal_kind: kind,
    seller_id: sellerId,
    currency: seller.currency,
    memo,
    entry_date: entryDate,
    lines: built.lines,
    total_debit_cents: built.total_debit_cents,
    total_credit_cents: built.total_credit_cents,
    balanced: built.balanced,
    affected_invoices: affected,
    supporting_records: supporting,
    expected,
  };
  return {
    proposal_kind: kind,
    source_type: kind,
    source_id: sourceId,
    source_event_id: expected.source_event_id,
    memo,
    entry_date: entryDate,
    preview,
    auto_fields: {},
  };
}

/** Pure date helper — no database access, so it stays synchronous. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ──────────────────────────────── planning ──────────────────────────────

export async function planOperation(db: SqlDb, op: OperationInput): Promise<PlanResult>{
  switch (op.kind) {
    case 'issue_invoice':
      return await planIssueInvoice(db, op);
    case 'record_payment':
      return await planRecordPayment(db, op);
    case 'allocate_payment':
      return await planAllocatePayment(db, op);
    case 'apply_credit_note':
      return await planApplyCreditNote(db, op);
    case 'record_fee':
      return await planRecordFee(db, op);
    case 'record_refund':
      return await planRecordRefund(db, op);
    case 'post_adjustment':
      return await planPostAdjustment(db, op);
  }
}

/**
 * Issue an invoice: DR AR for the total, CR revenue for the net and CR tax
 * for the tax. This is what establishes the receivable that payments later
 * settle, so without it the AR account has nothing but credits in it.
 */
async function planIssueInvoice(db: SqlDb, op: IssueInvoiceInput): Promise<PlanResult>{
  const invoice = await requireInvoice(db, op.seller_id, op.invoice_id);

  // An invoice that already has a posted issuance entry must not be issued
  // twice. The unique source_event_id would catch it anyway; this gives a
  // clearer error.
  const sourceEventId =
    op.source_event_id ?? `invoice_issued:${op.seller_id}:${invoice.id}`;
  const existing = await db.get(
      `SELECT id FROM journal_entries WHERE seller_id = ? AND source_event_id = ?`, [op.seller_id, sourceEventId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      `invoice ${invoice.number} has already been issued to the ledger`,
    );
  }

  if (invoice.total_cents !== invoice.subtotal_cents + invoice.tax_cents) {
    throw new LedgerError(
      'validation',
      `invoice ${invoice.number} total does not equal subtotal plus tax`,
    );
  }

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.AR,
      side: 'debit',
      amount_cents: invoice.total_cents,
      memo: `Invoice ${invoice.number}`,
    },
    {
      mapping_key: MAPPING_KEYS.REVENUE,
      side: 'credit',
      amount_cents: invoice.subtotal_cents,
      memo: `Invoice ${invoice.number} revenue`,
    },
  ];
  if (invoice.tax_cents > 0) {
    specs.push({
      mapping_key: MAPPING_KEYS.TAX_PAYABLE,
      side: 'credit',
      amount_cents: invoice.tax_cents,
      memo: `Invoice ${invoice.number} tax`,
    });
  }

  const result = await assemble(
    db,
    op.seller_id,
    'issue_invoice',
    `Invoice ${invoice.number} issued to ${invoice.customer_name}`,
    invoice.issue_date,
    specs,
    [],
    [
      {
        entity_type: 'invoice',
        entity_id: invoice.id,
        description: `${invoice.number} — ${invoice.customer_name}`,
        amount_cents: invoice.total_cents,
      },
    ],
    { seller_id: op.seller_id, invoices: [], source_event_id: sourceEventId },
    invoice.id,
  );
  result.auto_fields = {
    invoice_id: invoice.id,
    total_cents: invoice.total_cents,
    customer_name: invoice.customer_name,
  };
  result.auto_amount_cents = invoice.total_cents;
  return result;
}

/** Record a confirmed payment: DR cash, CR unapplied cash. */
async function planRecordPayment(db: SqlDb, op: RecordPaymentInput): Promise<PlanResult>{
  await assertPositive(op.amount_cents, 'payment amount');
  if (!op.received_at) {
    throw new LedgerError('validation', 'received_at is required');
  }

  const sourceEventId =
    op.source_event_id ??
    deriveSourceEventId('record_payment', op.seller_id, {
      amount_cents: op.amount_cents,
      received_at: op.received_at,
      reference: op.reference ?? null,
      payer_name: op.payer_name ?? null,
    });

  // Deterministic so a retry targets the same row rather than creating a
  // second payment for the same money.
  const paymentId = deterministicId('pay', sourceEventId);

  const existing = await db.get(`SELECT id FROM payments WHERE id = ?`, [paymentId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      `payment '${paymentId}' has already been recorded (duplicate source event)`,
    );
  }

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.CASH,
      side: 'debit',
      amount_cents: op.amount_cents,
      memo: op.reference ? `Payment ref ${op.reference}` : 'Payment received',
    },
    {
      mapping_key: MAPPING_KEYS.UNAPPLIED_CASH,
      side: 'credit',
      amount_cents: op.amount_cents,
      memo: 'Unapplied customer cash',
    },
  ];

  const result = await assemble(
    db,
    op.seller_id,
    'record_payment',
    op.reference
      ? `Payment received — ref ${op.reference}`
      : 'Payment received',
    op.received_at.slice(0, 10),
    specs,
    [],
    [
      {
        entity_type: 'payment',
        entity_id: paymentId,
        description: `Payment ${op.payer_name ?? 'customer'} ${
          op.reference ? `ref ${op.reference}` : ''
        }`.trim(),
        amount_cents: op.amount_cents,
      },
    ],
    {
      seller_id: op.seller_id,
      invoices: [],
      source_event_id: sourceEventId,
    },
    paymentId,
  );
  result.auto_fields = {
    amount_cents: op.amount_cents,
    received_at: op.received_at,
    reference: op.reference ?? null,
    payer_name: op.payer_name ?? null,
  };
  result.auto_amount_cents = op.amount_cents;
  // The preview tells the operator the id the payment will be created with,
  // which is what the follow-up allocation step refers to.
  result.preview.supporting_records[0]!.description += ` [will be created as ${paymentId}]`;
  return result;
}

/** Allocate a payment to an invoice: DR unapplied cash, CR AR. */
async function planAllocatePayment(db: SqlDb, op: AllocatePaymentInput): Promise<PlanResult>{
  await assertPositive(op.amount_cents, 'allocation amount');

  const payment = await requirePayment(db, op.seller_id, op.payment_id);
  await assertPaymentAllocatable(payment);

  const sourceEventId =
    op.source_event_id ??
    deriveSourceEventId('allocate_payment', op.seller_id, {
      payment_id: op.payment_id,
      invoice_id: op.invoice_id,
      amount_cents: op.amount_cents,
    });

  // Duplicate check before the funds check: on a retry the payment's
  // unallocated balance has already been spent by the first attempt, so
  // checking funds first would report a misleading 'insufficient funds'
  // instead of the accurate 'this is a duplicate'.
  const allocationId = deterministicId('alloc', sourceEventId);
  const existing = await db.get(`SELECT id FROM payment_allocations WHERE id = ?`, [allocationId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      'this allocation has already been posted (duplicate source event)',
    );
  }

  const available = await deriveUnallocatedCents(db, op.payment_id);
  if (op.amount_cents > available) {
    throw new LedgerError(
      'insufficient_funds',
      `allocation of ${op.amount_cents} exceeds the payment's unallocated ` +
        `balance of ${available}`,
    );
  }

  const invoice = await requireInvoice(db, op.seller_id, op.invoice_id);
  // A void or already-settled invoice must not accept further allocations.
  // Checked against live state here, and re-derived at post time.
  await assertInvoiceAcceptingPayment({
    ...invoice,
    balance_cents: (await deriveInvoiceState(db, invoice.id)).balance_cents,
  } as Parameters<typeof assertInvoiceAcceptingPayment>[0]);

  const applied = Math.min(op.amount_cents, invoice.balance_cents);
  const { change, supporting, expectedInvoice } = await balanceChange(
    db,
    op.seller_id,
    op.invoice_id,
    applied,
    'allocation',
  );

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.UNAPPLIED_CASH,
      side: 'debit',
      amount_cents: op.amount_cents,
      memo: `Apply to ${invoice.number}`,
    },
    {
      mapping_key: MAPPING_KEYS.AR,
      side: 'credit',
      amount_cents: op.amount_cents,
      memo: `Settle ${invoice.number}`,
    },
  ];

  const result = await assemble(
    db,
    op.seller_id,
    'allocate_payment',
    `Allocate ${payment.id} to invoice ${invoice.number}`,
    await today(),
    specs,
    [change],
    [
      supporting,
      {
        entity_type: 'payment',
        entity_id: payment.id,
        description: `Payment ${payment.reference ?? payment.id} (${
          payment.amount_cents
        } cents, ${available} unallocated)`,
        amount_cents: op.amount_cents,
      },
    ],
    {
      seller_id: op.seller_id,
      payment_id: payment.id,
      payment_version: payment.version,
      payment_status: payment.status,
      payment_unallocated_cents: available,
      invoices: [expectedInvoice],
      source_event_id: sourceEventId,
    },
    allocationId,
  );
  result.auto_fields = {
    payment_id: op.payment_id,
    invoice_id: op.invoice_id,
    amount_cents: op.amount_cents,
  };
  result.auto_amount_cents = op.amount_cents;
  return result;
}

/** Apply a credit note against an invoice: DR contra-revenue, CR AR. */
async function planApplyCreditNote(db: SqlDb, op: ApplyCreditNoteInput): Promise<PlanResult>{
  await assertPositive(op.amount_cents, 'credit note amount');
  const invoice = await requireInvoice(db, op.seller_id, op.invoice_id);
  if (invoice.status === 'void') {
    throw new LedgerError(
      'validation',
      `invoice ${invoice.number} is void; a credit note cannot be applied`,
    );
  }

  const sourceEventId =
    op.source_event_id ??
    deriveSourceEventId('apply_credit_note', op.seller_id, {
      invoice_id: op.invoice_id,
      amount_cents: op.amount_cents,
      reason: op.reason ?? null,
    });
  const creditNoteId = deterministicId('cn', sourceEventId);
  const existing = await db.get(`SELECT id FROM credit_notes WHERE id = ?`, [creditNoteId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      'this credit note has already been applied (duplicate source event)',
    );
  }

  const { change, supporting, expectedInvoice } = await balanceChange(
    db,
    op.seller_id,
    op.invoice_id,
    op.amount_cents,
    'credit note',
  );

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.CREDIT_NOTE,
      side: 'debit',
      amount_cents: op.amount_cents,
      memo: op.reason ?? `Credit note for ${invoice.number}`,
    },
    {
      mapping_key: MAPPING_KEYS.AR,
      side: 'credit',
      amount_cents: op.amount_cents,
      memo: `Credit ${invoice.number}`,
    },
  ];

  const result = await assemble(
    db,
    op.seller_id,
    'apply_credit_note',
    `Credit note applied to ${invoice.number}`,
    await today(),
    specs,
    [change],
    [supporting],
    {
      seller_id: op.seller_id,
      invoices: [expectedInvoice],
      source_event_id: sourceEventId,
    },
    creditNoteId,
  );
  result.auto_fields = {
    invoice_id: op.invoice_id,
    amount_cents: op.amount_cents,
    reason: op.reason ?? null,
  };
  result.auto_amount_cents = op.amount_cents;
  return result;
}

/** Record a processor fee: DR fee expense, CR cash. */
async function planRecordFee(db: SqlDb, op: RecordFeeInput): Promise<PlanResult>{
  await assertPositive(op.amount_cents, 'fee amount');
  if (!op.description) {
    throw new LedgerError('validation', 'fee description is required');
  }

  const supporting: SupportingRecord[] = [];
  if (op.payment_id) {
    const payment = await requirePayment(db, op.seller_id, op.payment_id);
    supporting.push({
      entity_type: 'payment',
      entity_id: payment.id,
      description: `Fee deducted from payment ${payment.reference ?? payment.id}`,
      amount_cents: op.amount_cents,
    });
  } else {
    supporting.push({
      entity_type: 'fee',
      entity_id: 'unlinked',
      description: op.description,
      amount_cents: op.amount_cents,
    });
  }

  const sourceEventId =
    op.source_event_id ??
    deriveSourceEventId('record_fee', op.seller_id, {
      payment_id: op.payment_id ?? null,
      amount_cents: op.amount_cents,
      description: op.description,
    });
  const feeId = deterministicId('fee', sourceEventId);
  const existing = await db.get(`SELECT id FROM fees WHERE id = ?`, [feeId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      'this fee has already been recorded (duplicate source event)',
    );
  }

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.FEE_EXPENSE,
      side: 'debit',
      amount_cents: op.amount_cents,
      memo: op.description,
    },
    {
      mapping_key: MAPPING_KEYS.CASH,
      side: 'credit',
      amount_cents: op.amount_cents,
      memo: op.description,
    },
  ];

  const result = await assemble(
    db,
    op.seller_id,
    'record_fee',
    `Fee — ${op.description}`,
    await today(),
    specs,
    [],
    supporting,
    {
      seller_id: op.seller_id,
      invoices: [],
      source_event_id: sourceEventId,
    },
    feeId,
  );
  result.auto_fields = {
    payment_id: op.payment_id ?? null,
    amount_cents: op.amount_cents,
    description: op.description,
  };
  result.auto_amount_cents = op.amount_cents;
  return result;
}

/** Record a refund: DR refund expense, CR cash. */
async function planRecordRefund(db: SqlDb, op: RecordRefundInput): Promise<PlanResult>{
  await assertPositive(op.amount_cents, 'refund amount');
  const payment = await requirePayment(db, op.seller_id, op.payment_id);

  const affected: InvoiceBalanceChange[] = [];
  const supporting: SupportingRecord[] = [
    {
      entity_type: 'payment',
      entity_id: payment.id,
      description: `Refund against payment ${payment.reference ?? payment.id}`,
      amount_cents: op.amount_cents,
    },
  ];
  const expectedInvoices: ExpectedState['invoices'] = [];

  if (op.invoice_id) {
    // A refund tied to an invoice puts the balance back up, so the reminder
    // recheck downstream will reinstate that invoice's reminders.
    const { change, supporting: s, expectedInvoice } = await balanceChange(
      db,
      op.seller_id,
      op.invoice_id,
      -op.amount_cents,
      'refund',
    );
    affected.push(change);
    supporting.push(s);
    expectedInvoices.push(expectedInvoice);
  }

  const sourceEventId =
    op.source_event_id ??
    deriveSourceEventId('record_refund', op.seller_id, {
      payment_id: op.payment_id,
      invoice_id: op.invoice_id ?? null,
      amount_cents: op.amount_cents,
      reason: op.reason ?? null,
    });
  const refundId = deterministicId('ref', sourceEventId);
  const existing = await db.get(`SELECT id FROM refunds WHERE id = ?`, [refundId]) as { id: string } | undefined;
  if (existing) {
    throw new LedgerError(
      'already_posted',
      'this refund has already been recorded (duplicate source event)',
    );
  }

  const specs: PostingSpec[] = [
    {
      mapping_key: MAPPING_KEYS.REFUND,
      side: 'debit',
      amount_cents: op.amount_cents,
      memo: op.reason ?? 'Customer refund',
    },
    {
      mapping_key: MAPPING_KEYS.CASH,
      side: 'credit',
      amount_cents: op.amount_cents,
      memo: op.reason ?? 'Customer refund',
    },
  ];

  const result = await assemble(
    db,
    op.seller_id,
    'record_refund',
    `Refund — ${op.reason ?? 'customer refund'}`,
    await today(),
    specs,
    affected,
    supporting,
    {
      seller_id: op.seller_id,
      invoices: expectedInvoices,
      source_event_id: sourceEventId,
    },
    refundId,
  );
  result.auto_fields = {
    payment_id: op.payment_id,
    invoice_id: op.invoice_id ?? null,
    amount_cents: op.amount_cents,
    reason: op.reason ?? null,
  };
  result.auto_amount_cents = op.amount_cents;
  return result;
}

/**
 * Post an approved adjustment.
 *
 * The adjustment row must already exist with status 'approved' and an
 * approved_by set. The schema's CHECK constraint makes an unapproved
 * adjustment impossible to represent, and this function refuses to post one
 * that is not approved — so there is no path that posts an adjustment nobody
 * signed off on.
 */
async function planPostAdjustment(db: SqlDb, op: PostAdjustmentInput): Promise<PlanResult>{
  const adjustment = await db.get(`SELECT * FROM adjustments WHERE id = ? AND seller_id = ?`, [op.adjustment_id, op.seller_id]) as
    | {
        id: string;
        seller_id: string;
        invoice_id: string | null;
        amount_cents: number;
        direction: 'debit' | 'credit';
        mapping_key: string;
        memo: string;
        approved_by: string | null;
        approved_at: string | null;
        status: string;
      }
    | undefined;

  if (!adjustment) {
    throw new LedgerError(
      'not_found',
      `adjustment '${op.adjustment_id}' not found`,
    );
  }
  if (adjustment.status === 'posted') {
    throw new LedgerError(
      'already_posted',
      `adjustment '${adjustment.id}' has already been posted`,
    );
  }
  if (adjustment.status === 'reversed') {
    throw new LedgerError(
      'conflict',
      `adjustment '${adjustment.id}' has been reversed`,
    );
  }
  if (adjustment.status !== 'approved' || !adjustment.approved_by) {
    throw new LedgerError(
      'not_approved',
      `adjustment '${adjustment.id}' is '${adjustment.status}'; it must be ` +
        `approved before it can be posted`,
    );
  }

  const sourceEventId =
    op.source_event_id ?? `adjustment:${op.seller_id}:${adjustment.id}`;

  const affected: InvoiceBalanceChange[] = [];
  const supporting: SupportingRecord[] = [
    {
      entity_type: 'adjustment',
      entity_id: adjustment.id,
      description: `Adjustment approved by ${adjustment.approved_by}: ${adjustment.memo}`,
      amount_cents: adjustment.amount_cents,
    },
  ];
  const expectedInvoices: ExpectedState['invoices'] = [];

  if (adjustment.invoice_id) {
    // 'debit' writes the amount off (balance down); 'credit' is a surcharge
    // (balance up), hence the sign flip feeding the preview.
    const applied =
      adjustment.direction === 'debit'
        ? adjustment.amount_cents
        : -adjustment.amount_cents;
    const { change, supporting: s, expectedInvoice } = await balanceChange(
      db,
      op.seller_id,
      adjustment.invoice_id,
      applied,
      'adjustment',
    );
    affected.push(change);
    supporting.push(s);
    expectedInvoices.push(expectedInvoice);
  }

  const specs: PostingSpec[] =
    adjustment.direction === 'debit'
      ? [
          {
            mapping_key: adjustment.mapping_key as PostingSpec['mapping_key'],
            side: 'debit' as const,
            amount_cents: adjustment.amount_cents,
            memo: adjustment.memo,
          },
          {
            mapping_key: MAPPING_KEYS.AR,
            side: 'credit' as const,
            amount_cents: adjustment.amount_cents,
            memo: adjustment.memo,
          },
        ]
      : [
          {
            mapping_key: MAPPING_KEYS.AR,
            side: 'debit' as const,
            amount_cents: adjustment.amount_cents,
            memo: adjustment.memo,
          },
          {
            mapping_key: adjustment.mapping_key as PostingSpec['mapping_key'],
            side: 'credit' as const,
            amount_cents: adjustment.amount_cents,
            memo: adjustment.memo,
          },
        ];

  const result = await assemble(
    db,
    op.seller_id,
    'post_adjustment',
    `Adjustment — ${adjustment.memo}`,
    await today(),
    specs,
    affected,
    supporting,
    {
      seller_id: op.seller_id,
      invoices: expectedInvoices,
      source_event_id: sourceEventId,
    },
    adjustment.id,
  );
  result.auto_fields = {
    adjustment_id: adjustment.id,
    amount_cents: adjustment.amount_cents,
    direction: adjustment.direction,
    mapping_key: adjustment.mapping_key,
  };
  result.auto_amount_cents = adjustment.amount_cents;
  return result;
}

/**
 * Plan the reversal of a posted entry: the exact negation of its lines.
 *
 * The reversal is a new entry linked via `reversal_of`. The original is never
 * updated except to flip its status to 'reversed', which the schema permits
 * and which is what excludes its effects from every derived balance.
 */
export async function planReversal(
  db: SqlDb,
  sellerId: string,
  entryId: string,
): Promise<{
  lines: Array<{ account_id: string; side: 'debit' | 'credit'; amount_cents: number }>;
  source_event_id: string;
  source_id: string;
  memo: string;
  entry_date: string;
  reversal_of: string;
}>{
  const entry = await db.get(
      `SELECT id, entry_no, memo, status, entry_kind, source_type, source_id
         FROM journal_entries WHERE id = ? AND seller_id = ?`, [entryId, sellerId]) as
    | {
        id: string;
        entry_no: number;
        memo: string;
        status: string;
        entry_kind: string;
        source_type: string;
        source_id: string;
      }
    | undefined;

  if (!entry) {
    throw new LedgerError('not_found', `journal entry '${entryId}' not found`);
  }
  if (entry.status === 'reversed') {
    throw new LedgerError(
      'already_posted',
      `journal entry ${entry.entry_no} has already been reversed`,
    );
  }
  if (entry.status !== 'posted') {
    throw new LedgerError(
      'immutable',
      `journal entry ${entry.entry_no} is not posted (status '${entry.status}')`,
    );
  }
  if (entry.entry_kind === 'reversal') {
    throw new LedgerError(
      'immutable',
      `journal entry ${entry.entry_no} is itself a reversal; a reversal of a ` +
        `reversal is not permitted — post a replacement entry instead`,
    );
  }

  const lines = await db.all(
      `SELECT account_id, amount_cents FROM journal_lines
        WHERE entry_id = ? ORDER BY line_no`, [entryId]) as Array<{ account_id: string; amount_cents: number }>;

  return {
    lines: lines.map((l) => ({
      account_id: l.account_id,
      side: l.amount_cents > 0 ? 'credit' : 'debit',
      amount_cents: Math.abs(l.amount_cents),
    })),
    source_event_id: `reversal:${sellerId}:${entryId}`,
    source_id: entryId,
    memo: `Reversal of entry ${entry.entry_no} — ${entry.memo}`,
    entry_date: await today(),
    reversal_of: entryId,
  };
}
