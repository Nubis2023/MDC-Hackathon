/**
 * Typed API client.
 *
 * Every request carries the acting user id in X-Actor-Id, which is what makes
 * the role and seller-access controls visible in the UI: switching the actor
 * changes what the interface will let you do, because the backend enforces it
 * rather than the frontend hiding buttons.
 */

export interface Actor {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

export interface SellerInfo {
  id: string;
  name: string;
  currency: string;
  authoritative_system: 'local' | 'external';
  role: string | null;
  posture: {
    authoritative_system: 'local' | 'external';
    local_ledger_is_authoritative: boolean;
    note: string;
  };
}

export interface Bootstrap {
  actor: Actor;
  sellers: SellerInfo[];
  users: Actor[];
}

export interface ProposedLine {
  account_id: string;
  account_code: string;
  account_name: string;
  amount_cents: number;
  side: 'debit' | 'credit';
  memo?: string;
}

export interface InvoiceBalanceChange {
  invoice_id: string;
  number: string;
  balance_before_cents: number;
  balance_after_cents: number;
  applied_cents: number;
}

export interface SupportingRecord {
  entity_type: string;
  entity_id: string;
  description: string;
  amount_cents?: number;
}

export interface LedgerPreview {
  proposal_kind: string;
  seller_id: string;
  currency: string;
  memo: string;
  entry_date: string;
  lines: ProposedLine[];
  total_debit_cents: number;
  total_credit_cents: number;
  balanced: boolean;
  affected_invoices: InvoiceBalanceChange[];
  supporting_records: SupportingRecord[];
}

export interface Proposal {
  id: string;
  seller_id: string;
  proposal_kind: string;
  status: 'proposed' | 'approved' | 'rejected' | 'posted' | 'superseded';
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approval_basis: 'manual' | 'auto_rule' | null;
  posted_entry_id: string | null;
  preview: LedgerPreview;
}

export interface ProposalSummary {
  id: string;
  proposal_kind: string;
  status: string;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approval_basis: string | null;
  posted_entry_id: string | null;
  summary: string;
  total_debit_cents: number;
  balanced: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  customer_name: string;
  issue_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  balance_cents: number;
  status: string;
  version: number;
}

export interface Payment {
  id: string;
  amount_cents: number;
  received_at: string;
  reference: string | null;
  payer_name: string | null;
  status: string;
  unallocated_cents: number;
}

export interface ReconciliationRow {
  invoice: Invoice;
  allocated_cents: number;
  expected_balance_cents: number;
  drift_cents: number;
  reconciled: boolean;
  allocations: Array<{
    allocation_id: string;
    payment_id: string;
    payment_reference: string | null;
    amount_cents: number;
    allocated_at: string;
    status: string;
    journal_entry_id: string | null;
  }>;
  reminders: Array<{
    id: string;
    kind: string;
    status: string;
    scheduled_for: string;
    suppressed_reason: string | null;
  }>;
}

export interface DriftItem {
  kind: string;
  entity_type: string;
  entity_id: string;
  description: string;
  expected_cents: number;
  actual_cents: number;
  diff_cents: number;
}

export interface ReconciliationSummary {
  seller_id: string;
  as_of: string;
  invoice_count: number;
  reconciled_count: number;
  drifted_count: number;
  total_outstanding_cents: number;
  total_allocated_cents: number;
  total_unapplied_cash_cents: number;
  trial_balance_cents: number;
  trial_balanced: boolean;
  drift: DriftItem[];
  authoritative_system: 'local' | 'external';
}

export interface AccountBalance {
  account_id: string;
  code: string;
  name: string;
  type: string;
  net_cents: number;
  debit_cents: number;
  credit_cents: number;
  line_count: number;
}

export interface JournalLine {
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  amount_cents: number;
  side: 'debit' | 'credit';
  memo: string | null;
}

export interface JournalEntry {
  id: string;
  entry_no: number;
  entry_date: string;
  memo: string;
  source_type: string;
  source_id: string;
  entry_kind: 'standard' | 'reversal';
  status: 'pending' | 'posted' | 'reversed';
  posted_at: string | null;
  posted_by: string | null;
  reversal_of: string | null;
  external_sync_state: string;
  external_ref: string | null;
  external_error: string | null;
  lines: JournalLine[];
  total_debit_cents: number;
  total_credit_cents: number;
  balanced: boolean;
}

export interface Reminder {
  id: string;
  invoice_id: string;
  invoice_number: string;
  kind: string;
  status: string;
  scheduled_for: string;
  suppressed_reason: string | null;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: unknown;
  created_at: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  mutates_ledger: boolean;
  requires_human: boolean;
  approval_note: string;
}

export interface Adjustment {
  id: string;
  invoice_id: string | null;
  amount_cents: number;
  direction: 'debit' | 'credit';
  mapping_key: string;
  memo: string;
  status: string;
  approved_by: string | null;
}

export interface AutoPostRule {
  id: string;
  name: string;
  enabled: number;
  proposal_kind: string;
  match_mode: string;
  match_json: string;
  max_amount_cents: number | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, code: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

let actorId = 'user_owner_1';

export function setActor(id: string): void {
  actorId = id;
}

export function getActorId(): string {
  return actorId;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Actor-Id': actorId,
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; detail?: unknown } })
      ?.error;
    throw new ApiError(
      err?.message ?? `request failed (${res.status})`,
      err?.code ?? 'unknown',
      res.status,
      err?.detail,
    );
  }
  return body as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  reconciliation: (sellerId: string) =>
    request<{
      summary: ReconciliationSummary;
      rows: ReconciliationRow[];
      accounts: AccountBalance[];
      posture: { authoritative_system: string; local_ledger_is_authoritative: boolean; note: string };
    }>(`/api/sellers/${sellerId}/reconciliation`),

  invoices: (sellerId: string) =>
    request<{ invoices: Invoice[] }>(`/api/sellers/${sellerId}/invoices`),

  /**
   * Place an invoice. Creates the document and its reminder ladder only —
   * posting the receivable to the ledger is a separate, approvable step.
   */
  createInvoice: (
    sellerId: string,
    body: {
      customer_name: string;
      number: string;
      issue_date: string;
      due_date: string;
      subtotal_cents: number;
      tax_cents?: number;
    },
  ) =>
    request<{ invoice: Invoice; next_operation: Record<string, unknown> }>(
      `/api/sellers/${sellerId}/invoices`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  payments: (sellerId: string) =>
    request<{ payments: Payment[] }>(`/api/sellers/${sellerId}/payments`),

  proposals: (sellerId: string) =>
    request<{ proposals: Proposal[]; summaries: ProposalSummary[] }>(
      `/api/sellers/${sellerId}/proposals`,
    ),

  preview: (sellerId: string, operation: Record<string, unknown>) =>
    request<{ preview: LedgerPreview }>(
      `/api/sellers/${sellerId}/proposals/preview`,
      { method: 'POST', body: JSON.stringify({ operation }) },
    ),

  propose: (sellerId: string, operation: Record<string, unknown>, idempotencyKey?: string) =>
    request<{ proposal: Proposal }>(`/api/sellers/${sellerId}/proposals`, {
      method: 'POST',
      body: JSON.stringify({ operation, idempotency_key: idempotencyKey }),
    }),

  approve: (proposalId: string, reason?: string) =>
    request<{ result: unknown; ok: boolean }>(
      `/api/proposals/${proposalId}/approve`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  reject: (proposalId: string, reason: string) =>
    request<{ proposal: Proposal }>(`/api/proposals/${proposalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  post: (proposalId: string, idempotencyKey?: string) =>
    request<{ ok: boolean; result: unknown }>(
      `/api/proposals/${proposalId}/post`,
      { method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey }) },
    ),

  journal: (sellerId: string) =>
    request<{
      entries: JournalEntry[];
      reversible: Array<{ id: string; entry_no: number; memo: string }>;
    }>(`/api/sellers/${sellerId}/journal`),

  reverse: (entryId: string, reason: string) =>
    request<{ ok: boolean; result: unknown; error?: { message: string } }>(
      `/api/journal/${entryId}/reverse`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  reminders: (sellerId: string) =>
    request<{ reminders: Reminder[]; outstanding: Reminder[] }>(
      `/api/sellers/${sellerId}/reminders`,
    ),

  audit: (sellerId: string) =>
    request<{ events: AuditEvent[] }>(`/api/sellers/${sellerId}/audit`),

  sync: (sellerId: string) =>
    request<{
      posture: { authoritative_system: string; note: string };
      pending: Array<{ id: string; entry_no: number; memo: string; external_sync_state: string }>;
    }>(`/api/sellers/${sellerId}/sync`),

  syncAttempt: (
    entryId: string,
    body: { platform?: string; state: string; external_ref?: string; error_message?: string },
  ) =>
    request<{ sync_attempt_id: string }>(
      `/api/journal/${entryId}/sync-attempt`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  adjustments: (sellerId: string) =>
    request<{ adjustments: Adjustment[] }>(`/api/sellers/${sellerId}/adjustments`),

  createAdjustment: (sellerId: string, body: Record<string, unknown>) =>
    request<{ adjustment: Adjustment }>(`/api/sellers/${sellerId}/adjustments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  approveAdjustment: (sellerId: string, adjustmentId: string) =>
    request<{ adjustment: Adjustment }>(
      `/api/sellers/${sellerId}/adjustments/${adjustmentId}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  autoPostRules: (sellerId: string) =>
    request<{ rules: AutoPostRule[] }>(`/api/sellers/${sellerId}/auto-post-rules`),

  setAutoPostRuleEnabled: (sellerId: string, ruleId: string, enabled: boolean) =>
    request<{ rules: AutoPostRule[] }>(
      `/api/sellers/${sellerId}/auto-post-rules/${ruleId}/enabled`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),

  tools: () => request<{ tools: ToolDefinition[] }>('/api/agent/tools'),

  callTool: (toolName: string, args: Record<string, unknown>) =>
    request<{ ok: boolean; tool: string; result?: unknown; error?: { code: string; message: string } }>(
      `/api/agent/tools/${toolName}`,
      { method: 'POST', body: JSON.stringify(args) },
    ),
};

// ───────────────────────────── formatting ───────────────────────────────

export function money(cents: number, currency = 'USD'): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${negative ? '-' : ''}${symbol}${whole}.${frac}`;
}

export function parseMoney(input: string): number {
  const raw = input.trim().replace(/[$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`enter a positive dollar amount like 1250.00 (got "${input}")`);
  }
  const [whole, frac = ''] = raw.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function timestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
