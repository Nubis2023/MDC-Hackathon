// Domain types shared by the ledger service, the agent tools and the API.

export type SellerId = string;
export type UserId = string;

export type UserKind = 'human' | 'agent';
export type MembershipRole = 'owner' | 'approver' | 'bookkeeper' | 'viewer';

export interface Seller {
  id: SellerId;
  name: string;
  currency: string;
  authoritative_system: 'local' | 'external';
}

export interface Actor {
  id: UserId;
  name: string;
  kind: UserKind;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface GlAccount {
  id: string;
  seller_id: SellerId;
  code: string;
  name: string;
  type: AccountType;
}

export type MappingSide = 'debit' | 'credit' | 'auto';

export interface AccountMapping {
  mapping_key: string;
  side: MappingSide;
  account_id: string;
}

/**
 * The ledger events the system knows how to post. Each maps to a configured
 * set of accounts via account_mappings, so the service never hardcodes an
 * account code.
 */
export const MAPPING_KEYS = {
  /** Cash received into the seller's bank/clearing account. */
  CASH: 'cash',
  /**
   * Customer cash received but not yet applied to an invoice. Recording a
   * payment credits this; allocating it debits it back out against AR. This
   * is what makes the allocation step itself a real journal entry rather
   * than a subledger-only change.
   */
  UNAPPLIED_CASH: 'unapplied_cash',
  /** Accounts receivable — the invoice control account. */
  AR: 'accounts_receivable',
  /** Revenue recognised when an invoice is issued. */
  REVENUE: 'revenue',
  /** Sales tax payable. */
  TAX_PAYABLE: 'tax_payable',
  /** Contra-revenue for credit notes. */
  CREDIT_NOTE: 'credit_note',
  /** Payment processor fee expense. */
  FEE_EXPENSE: 'fee_expense',
  /** Refunds paid out to customers. */
  REFUND: 'refund_expense',
  /** Suspense / adjustments account. */
  ADJUSTMENT: 'adjustment',
} as const;

export type MappingKey = (typeof MAPPING_KEYS)[keyof typeof MAPPING_KEYS];

export const ALL_MAPPING_KEYS: MappingKey[] = Object.values(MAPPING_KEYS);

export type ProposalKind =
  | 'issue_invoice'
  | 'record_payment'
  | 'allocate_payment'
  | 'apply_credit_note'
  | 'record_fee'
  | 'record_refund'
  | 'post_adjustment'
  | 'reverse_entry';

/**
 * One leg of a proposed journal entry, expressed as a configured mapping
 * rather than an account code.
 */
export interface PostingSpec {
  mapping_key: MappingKey;
  side: 'debit' | 'credit';
  amount_cents: number;
  memo?: string;
}

export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'superseded';

export type ExternalSyncState =
  | 'not_applicable'
  | 'pending'
  | 'confirmed'
  | 'failed';

/** A single proposed journal line, pre-posting. */
export interface ProposedLine {
  account_id: string;
  account_code: string;
  account_name: string;
  /** Positive cents; the side decides the sign when the entry is built. */
  amount_cents: number;
  side: 'debit' | 'credit';
  memo?: string;
}

export interface InvoiceBalanceChange {
  invoice_id: string;
  number: string;
  balance_before_cents: number;
  balance_after_cents: number;
  /** Positive = the invoice balance was reduced by this posting. */
  applied_cents: number;
}

export interface SupportingRecord {
  entity_type: string;
  entity_id: string;
  description: string;
  amount_cents?: number;
}

/**
 * The preview shown to an approver before anything is committed. The
 * requirement is explicit that this must include the proposed debits and
 * credits, affected invoices, balance changes and supporting source records.
 */
export interface LedgerPreview {
  proposal_kind: ProposalKind;
  seller_id: SellerId;
  currency: string;
  memo: string;
  entry_date: string;
  lines: ProposedLine[];
  total_debit_cents: number;
  total_credit_cents: number;
  balanced: boolean;
  affected_invoices: InvoiceBalanceChange[];
  supporting_records: SupportingRecord[];
  /** State captured at propose time that the post step revalidates. */
  expected: ExpectedState;
}

/** Everything revalidated immediately before commit. */
export interface ExpectedState {
  seller_id: SellerId;
  payment_id?: string;
  payment_version?: number;
  payment_status?: string;
  payment_unallocated_cents?: number;
  invoices: Array<{
    invoice_id: string;
    version: number;
    balance_cents: number;
    status: string;
  }>;
  source_event_id: string;
}

export interface Proposal {
  id: string;
  seller_id: SellerId;
  proposal_kind: ProposalKind;
  source_type: string;
  source_id: string;
  source_event_id: string;
  idempotency_key: string | null;
  status: ProposalStatus;
  proposed_by: UserId;
  proposed_at: string;
  approved_by: UserId | null;
  approved_at: string | null;
  rejected_by: UserId | null;
  rejection_reason: string | null;
  posted_entry_id: string | null;
  approval_basis: 'manual' | 'auto_rule' | null;
  auto_rule_id: string | null;
  preview: LedgerPreview;
  expected: ExpectedState;
}

export interface JournalLineRecord {
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  amount_cents: number;
  /** Derived from the sign of amount_cents for display. */
  side: 'debit' | 'credit';
  memo: string | null;
}

export interface JournalEntryRecord {
  id: string;
  seller_id: SellerId;
  entry_no: number;
  entry_date: string;
  memo: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  idempotency_key: string | null;
  reversal_of: string | null;
  entry_kind: 'standard' | 'reversal';
  status: 'pending' | 'posted' | 'reversed';
  posted_at: string | null;
  posted_by: UserId | null;
  external_sync_state: ExternalSyncState;
  external_ref: string | null;
  external_synced_at: string | null;
  external_error: string | null;
  lines: JournalLineRecord[];
  total_debit_cents: number;
  total_credit_cents: number;
  balanced: boolean;
}

export interface PaymentRecord {
  id: string;
  seller_id: SellerId;
  amount_cents: number;
  currency: string;
  received_at: string;
  reference: string | null;
  payer_name: string | null;
  status: 'confirmed' | 'reversed';
  unallocated_cents: number;
  version: number;
}

export interface InvoiceRecord {
  id: string;
  seller_id: SellerId;
  customer_name: string;
  number: string;
  issue_date: string;
  due_date: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  balance_cents: number;
  status: 'open' | 'partially_paid' | 'paid' | 'void';
  version: number;
}

/** One row of the reconciliation interface. */
export interface ReconciliationRow {
  invoice: InvoiceRecord;
  allocated_cents: number;
  /** balance_cents minus what the invoice's own allocations account for. */
  expected_balance_cents: number;
  /** Non-zero means the stored balance disagrees with the allocation ledger. */
  drift_cents: number;
  allocations: Array<{
    allocation_id: string;
    payment_id: string;
    payment_reference: string | null;
    amount_cents: number;
    allocated_at: string;
    status: 'active' | 'reversed';
    journal_entry_id: string | null;
  }>;
  reminders: Array<{
    id: string;
    kind: string;
    status: string;
    scheduled_for: string;
    suppressed_reason: string | null;
  }>;
  reconciled: boolean;
}
