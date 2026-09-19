/**
 * The ledger write pipeline: propose → approve → post, plus reversal.
 *
 * This module holds the controls the requirements call for, in one place so
 * they cannot be bypassed by a caller that skips a step:
 *
 *   propose   records the proposed entry, the preview shown to the approver,
 *             and the state the poster must revalidate against.
 *   approve   records a seller's approval. An actor may never approve a
 *             proposal it raised itself, and an agent may not approve at all.
 *   post      commits, in ONE transaction: the journal entry and its lines,
 *             the subledger effect (payment/allocation/credit note/fee/refund/
 *             adjustment), the invoice balance changes, the audit event, and
 *             the reminder recheck.
 *   reverse   posts a linked reversal entry and flips the original's status.
 *             Posted rows are never edited.
 *
 * Duplicate defence is layered, because each layer catches a different retry:
 *   - idempotency_key    catches a client retrying the same HTTP request
 *   - source_event_id    catches the same business event arriving twice
 *   - deterministic ids  make a retry target the same source row
 *   - optimistic version checks catch a concurrent writer that got there first
 */

import type { Db } from '../db';
import { immediateTransaction } from '../db';
import { LedgerError } from '../domain/errors';
import type {
  Actor,
  ExpectedState,
  LedgerPreview,
  Proposal,
  ProposalKind,
  ProposedLine,
} from '../domain/types';
import {
  assertCanApprove,
  assertCanPost,
  assertSellerAccess,
} from './access';
import { writeAuditEvent } from './audit';
import { findMatchingAutoPostRule } from './auto-post';
import { initialSyncStateForSeller } from './external-sync';
import { deterministicId, newId } from './ids';
import {
  getJournalEntry,
  insertPostedEntry,
  listJournalEntries,
} from './journal';
import { deriveInvoiceState, recomputeInvoiceState } from './invoices';
import { planOperation, planReversal, type OperationInput } from './plan';
import {
  deriveUnallocatedCents,
  recomputePaymentUnallocated,
  requirePayment,
} from './payments';
import { recheckReminderEligibility } from './reminders';

// ─────────────────────────────── propose ────────────────────────────────

export interface ProposeOptions {
  idempotencyKey?: string | null;
}

/**
 * Record a proposal for a ledger update.
 *
 * Nothing financial is committed here — only the proposal row. A proposal is
 * re-planned in full by `post`, so the numbers an approver saw are verified
 * again at commit time rather than trusted.
 */
export function proposeLedgerUpdate(
  db: Db,
  actor: Actor,
  op: OperationInput,
  options: ProposeOptions = {},
): Proposal {
  const sellerId = op.seller_id;
  assertSellerAccess(db, sellerId, actor);

  const plan = planOperation(db, op);

  // Replay: the same idempotency key returns the existing proposal instead of
  // raising a second one for the same request.
  if (options.idempotencyKey) {
    const existing = db
      .prepare(
        `SELECT id, status FROM ledger_proposals
          WHERE seller_id = ? AND idempotency_key = ?`,
      )
      .get(sellerId, options.idempotencyKey) as
      | { id: string; status: string }
      | undefined;
    if (existing) {
      const prior = getProposal(db, existing.id);
      if (prior) return prior;
    }
  }

  // A proposal for this source event may already exist.
  const dup = db
    .prepare(
      `SELECT id, status FROM ledger_proposals
        WHERE seller_id = ? AND source_event_id = ?`,
    )
    .get(sellerId, plan.source_event_id) as
    | { id: string; status: string }
    | undefined;
  if (dup) {
    throw new LedgerError(
      'duplicate',
      `a proposal for this source event already exists (status '${dup.status}')`,
      { detail: { proposal_id: dup.id } },
    );
  }

  const proposalId = newId('prop');
  db.prepare(
    `INSERT INTO ledger_proposals
       (id, seller_id, proposal_kind, source_type, source_id, source_event_id,
        idempotency_key, preview_json, operation_json, expected_json, status,
        proposed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  ).run(
    proposalId,
    sellerId,
    plan.proposal_kind,
    plan.source_type,
    plan.source_id,
    plan.source_event_id,
    options.idempotencyKey ?? null,
    JSON.stringify(plan.preview),
    JSON.stringify(op),
    JSON.stringify(plan.preview.expected),
    actor.id,
  );

  writeAuditEvent(db, {
    seller_id: sellerId,
    actor,
    action: 'proposal.created',
    entity_type: 'ledger_proposal',
    entity_id: proposalId,
    detail: {
      proposal_kind: plan.proposal_kind,
      source_event_id: plan.source_event_id,
      total_debit_cents: plan.preview.total_debit_cents,
      balanced: plan.preview.balanced,
    },
  });

  const created = getProposal(db, proposalId);
  if (!created) {
    throw new LedgerError('not_found', 'proposal vanished after insert');
  }
  return created;
}

/**
 * Render the preview without persisting anything. Used by the UI's "what
 * would this do" affordance and by the agent's preview_ledger_update tool.
 */
export function previewLedgerUpdate(
  db: Db,
  actor: Actor,
  op: OperationInput,
): LedgerPreview {
  assertSellerAccess(db, op.seller_id, actor);
  return planOperation(db, op).preview;
}

// ──────────────────────────────── read ──────────────────────────────────

interface ProposalRow {
  id: string;
  seller_id: string;
  proposal_kind: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  idempotency_key: string | null;
  preview_json: string;
  operation_json: string;
  expected_json: string;
  status: string;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  posted_entry_id: string | null;
  approval_basis: 'manual' | 'auto_rule' | null;
  auto_rule_id: string | null;
  auto_rule_match_json: string | null;
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    seller_id: row.seller_id,
    proposal_kind: row.proposal_kind as ProposalKind,
    source_type: row.source_type,
    source_id: row.source_id,
    source_event_id: row.source_event_id,
    idempotency_key: row.idempotency_key,
    status: row.status as Proposal['status'],
    proposed_by: row.proposed_by,
    proposed_at: row.proposed_at,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    rejected_by: row.rejected_by,
    rejection_reason: row.rejection_reason,
    posted_entry_id: row.posted_entry_id,
    approval_basis: row.approval_basis,
    auto_rule_id: row.auto_rule_id,
    preview: JSON.parse(row.preview_json) as LedgerPreview,
    expected: JSON.parse(row.expected_json) as ExpectedState,
  };
}

export function getProposal(db: Db, proposalId: string): Proposal | null {
  const row = db
    .prepare(`SELECT * FROM ledger_proposals WHERE id = ?`)
    .get(proposalId) as ProposalRow | undefined;
  return row ? rowToProposal(row) : null;
}

export function getProposalForActor(
  db: Db,
  actor: Actor,
  proposalId: string,
): Proposal {
  const proposal = getProposal(db, proposalId);
  if (!proposal) {
    throw new LedgerError('not_found', `proposal '${proposalId}' not found`);
  }
  assertSellerAccess(db, proposal.seller_id, actor);
  return proposal;
}

export function listProposals(
  db: Db,
  actor: Actor,
  sellerId: string,
  status?: Proposal['status'],
): Proposal[] {
  assertSellerAccess(db, sellerId, actor);
  const rows = status
    ? (db
        .prepare(
          `SELECT * FROM ledger_proposals WHERE seller_id = ? AND status = ?
            ORDER BY proposed_at DESC, rowid DESC`,
        )
        .all(sellerId, status) as ProposalRow[])
    : (db
        .prepare(
          `SELECT * FROM ledger_proposals WHERE seller_id = ?
            ORDER BY proposed_at DESC, rowid DESC LIMIT 200`,
        )
        .all(sellerId) as ProposalRow[]);
  return rows.map(rowToProposal);
}

// ─────────────────────────────── approve ────────────────────────────────

export interface ApproveOptions {
  reason?: string;
}

/**
 * Record approval of a proposal.
 *
 * Two independent controls, both enforced here rather than in the caller:
 *   1. An agent may never approve. Approval represents a seller decision, so
 *      it requires a human with an approver or owner role.
 *   2. Nobody may approve a proposal they raised themselves — this is what
 *      stops the proposing agent (or bookkeeper) from self-authorising.
 */
export function approveLedgerUpdate(
  db: Db,
  actor: Actor,
  proposalId: string,
  options: ApproveOptions = {},
): Proposal {
  const proposal = getProposalForActor(db, actor, proposalId);

  if (actor.kind === 'agent') {
    throw new LedgerError(
      'self_approval',
      'an agent may not approve a ledger update; approval must come from a seller user',
    );
  }

  if (proposal.proposed_by === actor.id) {
    throw new LedgerError(
      'self_approval',
      'a proposal cannot be approved by the actor that raised it',
    );
  }

  if (proposal.status === 'posted') {
    throw new LedgerError(
      'already_posted',
      `proposal '${proposalId}' has already been posted`,
    );
  }
  if (proposal.status === 'rejected') {
    throw new LedgerError(
      'conflict',
      `proposal '${proposalId}' was rejected and cannot be approved`,
    );
  }
  if (proposal.status === 'approved') {
    // Idempotent: re-approving by the same approver is a no-op.
    return proposal;
  }

  assertCanApprove(db, proposal.seller_id, actor);

  db.prepare(
    `UPDATE ledger_proposals
        SET status = 'approved', approved_by = ?, approved_at = ?,
            approval_basis = 'manual'
      WHERE id = ?`,
  ).run(actor.id, new Date().toISOString(), proposalId);

  writeAuditEvent(db, {
    seller_id: proposal.seller_id,
    actor,
    action: 'proposal.approved',
    entity_type: 'ledger_proposal',
    entity_id: proposalId,
    detail: {
      proposal_kind: proposal.proposal_kind,
      reason: options.reason ?? null,
      approved_by: actor.id,
    },
  });

  const updated = getProposal(db, proposalId);
  if (!updated) throw new LedgerError('not_found', 'proposal vanished');
  return updated;
}

export function rejectLedgerUpdate(
  db: Db,
  actor: Actor,
  proposalId: string,
  reason: string,
): Proposal {
  const proposal = getProposalForActor(db, actor, proposalId);
  if (proposal.status === 'posted') {
    throw new LedgerError(
      'already_posted',
      'a posted proposal cannot be rejected; reverse the entry instead',
    );
  }
  if (proposal.status === 'rejected') return proposal;

  db.prepare(
    `UPDATE ledger_proposals
        SET status = 'rejected', rejected_by = ?, rejected_at = ?,
            rejection_reason = ?
      WHERE id = ?`,
  ).run(actor.id, new Date().toISOString(), reason, proposalId);

  writeAuditEvent(db, {
    seller_id: proposal.seller_id,
    actor,
    action: 'proposal.rejected',
    entity_type: 'ledger_proposal',
    entity_id: proposalId,
    detail: { reason },
  });

  const updated = getProposal(db, proposalId);
  if (!updated) throw new LedgerError('not_found', 'proposal vanished');
  return updated;
}

// ────────────────────────── revalidation ────────────────────────────────

/**
 * Compare the state captured at propose time against live state, immediately
 * before committing.
 *
 * This is the check that makes a stale approval safe. If a payment was
 * allocated elsewhere, or an invoice was settled, or another posting bumped a
 * version, the proposal no longer describes reality and posting is refused.
 */
function revalidate(db: Db, expected: ExpectedState): void {
  const conflicts: string[] = [];

  if (expected.payment_id) {
    const payment = db
      .prepare(
        `SELECT id, version, status, unallocated_cents FROM payments WHERE id = ?`,
      )
      .get(expected.payment_id) as
      | {
          id: string;
          version: number;
          status: string;
          unallocated_cents: number;
        }
      | undefined;

    if (!payment) {
      conflicts.push(`payment ${expected.payment_id} no longer exists`);
    } else {
      if (
        expected.payment_version !== undefined &&
        payment.version !== expected.payment_version
      ) {
        conflicts.push(
          `payment ${payment.id} changed version ${expected.payment_version} -> ${payment.version}`,
        );
      }
      if (
        expected.payment_status !== undefined &&
        payment.status !== expected.payment_status
      ) {
        conflicts.push(
          `payment ${payment.id} status changed ${expected.payment_status} -> ${payment.status}`,
        );
      }
      if (
        expected.payment_unallocated_cents !== undefined &&
        payment.unallocated_cents !== expected.payment_unallocated_cents
      ) {
        conflicts.push(
          `payment ${payment.id} unallocated changed ` +
            `${expected.payment_unallocated_cents} -> ${payment.unallocated_cents}`,
        );
      }
    }
  }

  for (const exp of expected.invoices) {
    const live = db
      .prepare(`SELECT id, version, status, number FROM invoices WHERE id = ?`)
      .get(exp.invoice_id) as
      | { id: string; version: number; status: string; number: string }
      | undefined;
    if (!live) {
      conflicts.push(`invoice ${exp.invoice_id} no longer exists`);
      continue;
    }
    if (live.version !== exp.version) {
      conflicts.push(
        `invoice ${live.number} changed version ${exp.version} -> ${live.version}`,
      );
    }
    if (live.status !== exp.status) {
      conflicts.push(
        `invoice ${live.number} status changed ${exp.status} -> ${live.status}`,
      );
    }
    const derived = deriveInvoiceState(db, live.id);
    if (derived.balance_cents !== exp.balance_cents) {
      conflicts.push(
        `invoice ${live.number} balance changed ${exp.balance_cents} -> ${derived.balance_cents}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new LedgerError(
      'stale_state',
      `refusing to post: the state this proposal was based on has changed (${conflicts.join('; ')})`,
      { detail: { conflicts } },
    );
  }
}

// ───────────────────────── apply subledger effects ──────────────────────

/**
 * Apply the operation's non-journal effects: the source row it creates or
 * mutates, and the invoice balances that follow from it.
 *
 * Runs inside the posting transaction, after revalidation. Returns the
 * invoice ids whose reminders need rechecking.
 */
function applyEffects(
  db: Db,
  op: OperationInput,
  sourceEventId: string,
  entryId: string,
): string[] {
  const touchedInvoices = new Set<string>();

  switch (op.kind) {
    case 'issue_invoice': {
      // The journal is the only effect; the invoice row already exists.
      break;
    }

    case 'record_payment': {
      const paymentId = deterministicId('pay', sourceEventId);
      db.prepare(
        `INSERT INTO payments
           (id, seller_id, amount_cents, currency, received_at, reference,
            payer_name, status, unallocated_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
      ).run(
        paymentId,
        op.seller_id,
        op.amount_cents,
        op.currency ?? 'USD',
        op.received_at,
        op.reference ?? null,
        op.payer_name ?? null,
        op.amount_cents,
      );
      break;
    }

    case 'allocate_payment': {
      const allocationId = deterministicId('alloc', sourceEventId);
      db.prepare(
        `INSERT INTO payment_allocations
           (id, seller_id, payment_id, invoice_id, amount_cents, status,
            journal_entry_id)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        allocationId,
        op.seller_id,
        op.payment_id,
        op.invoice_id,
        op.amount_cents,
        entryId,
      );
      recomputePaymentUnallocated(db, op.payment_id);
      recomputeInvoiceState(db, op.invoice_id);
      touchedInvoices.add(op.invoice_id);
      break;
    }

    case 'apply_credit_note': {
      const creditNoteId = deterministicId('cn', sourceEventId);
      db.prepare(
        `INSERT INTO credit_notes
           (id, seller_id, invoice_id, amount_cents, reason, status)
         VALUES (?, ?, ?, ?, ?, 'applied')`,
      ).run(
        creditNoteId,
        op.seller_id,
        op.invoice_id,
        op.amount_cents,
        op.reason ?? null,
      );
      recomputeInvoiceState(db, op.invoice_id);
      touchedInvoices.add(op.invoice_id);
      break;
    }

    case 'record_fee': {
      const feeId = deterministicId('fee', sourceEventId);
      db.prepare(
        `INSERT INTO fees
           (id, seller_id, payment_id, amount_cents, description, status)
         VALUES (?, ?, ?, ?, ?, 'charged')`,
      ).run(
        feeId,
        op.seller_id,
        op.payment_id ?? null,
        op.amount_cents,
        op.description,
      );
      break;
    }

    case 'record_refund': {
      const refundId = deterministicId('ref', sourceEventId);
      db.prepare(
        `INSERT INTO refunds
           (id, seller_id, payment_id, invoice_id, amount_cents, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, 'refunded')`,
      ).run(
        refundId,
        op.seller_id,
        op.payment_id,
        op.invoice_id ?? null,
        op.amount_cents,
        op.reason ?? null,
      );
      if (op.invoice_id) {
        recomputeInvoiceState(db, op.invoice_id);
        touchedInvoices.add(op.invoice_id);
      }
      break;
    }

    case 'post_adjustment': {
      const info = db
        .prepare(
          `UPDATE adjustments SET status = 'posted'
            WHERE id = ? AND seller_id = ? AND status = 'approved'`,
        )
        .run(op.adjustment_id, op.seller_id);
      if (info.changes === 0) {
        // Revalidation ran moments ago; reaching here means the adjustment
        // was mutated concurrently. Abort the whole transaction.
        throw new LedgerError(
          'stale_state',
          `adjustment '${op.adjustment_id}' is no longer in an approved state`,
        );
      }
      const adj = db
        .prepare(`SELECT invoice_id FROM adjustments WHERE id = ?`)
        .get(op.adjustment_id) as { invoice_id: string | null };
      if (adj.invoice_id) {
        recomputeInvoiceState(db, adj.invoice_id);
        touchedInvoices.add(adj.invoice_id);
      }
      break;
    }
  }

  return [...touchedInvoices];
}

// ──────────────────────────────── post ──────────────────────────────────

export interface PostOptions {
  idempotencyKey?: string | null;
}

export interface PostResult {
  proposal: Proposal;
  entry_id: string;
  /** True when this call replayed an already-posted entry rather than posting. */
  replayed: boolean;
  reminders: Array<{ invoice_id: string; suppressed: string[]; reinstated: string[] }>;
}

/**
 * Commit a proposal.
 *
 * Everything below happens inside one IMMEDIATE transaction:
 *   1. idempotent replay check
 *   2. approval / auto-rule authorisation check
 *   3. re-plan from the original operation input
 *   4. revalidate captured state against live state
 *   5. apply subledger effects
 *   6. insert the journal entry (balance trigger + unique source event)
 *   7. audit events
 *   8. reminder recheck
 *
 * If any step throws, the transaction rolls back and no partial posting
 * survives — an allocation cannot exist without its journal entry, and a
 * balance cannot move without both.
 */
export function postLedgerUpdate(
  db: Db,
  actor: Actor,
  proposalId: string,
  options: PostOptions = {},
): PostResult {
  return immediateTransaction(db, () => {
    const proposal = getProposal(db, proposalId);
    if (!proposal) {
      throw new LedgerError('not_found', `proposal '${proposalId}' not found`);
    }
    assertSellerAccess(db, proposal.seller_id, actor);

    // ── 1. Idempotent replay ────────────────────────────────────────────
    const replayKey = options.idempotencyKey ?? proposal.idempotency_key;
    if (replayKey) {
      const prior = db
        .prepare(
          `SELECT id FROM journal_entries
            WHERE seller_id = ? AND idempotency_key = ?`,
        )
        .get(proposal.seller_id, replayKey) as { id: string } | undefined;
      if (prior) {
        const refreshed = getProposal(db, proposalId);
        return {
          proposal: refreshed ?? proposal,
          entry_id: prior.id,
          replayed: true,
          reminders: [],
        };
      }
    }

    if (proposal.status === 'posted' && proposal.posted_entry_id) {
      return {
        proposal,
        entry_id: proposal.posted_entry_id,
        replayed: true,
        reminders: [],
      };
    }
    if (proposal.status === 'rejected') {
      throw new LedgerError(
        'conflict',
        'refusing to post a rejected proposal',
      );
    }

    // ── 2. Authorisation ────────────────────────────────────────────────
    assertCanPost(db, proposal.seller_id, actor);

    let approvalBasis: 'manual' | 'auto_rule' | null = null;
    let autoRuleId: string | null = null;
    let autoMatchJson: string | null = null;

    if (proposal.status === 'approved') {
      approvalBasis = 'manual';
    } else {
      // Not approved: the only other way to post is an enabled exact-match
      // auto-post rule that explicitly authorises this operation.
      const op = JSON.parse(
        (db
          .prepare(`SELECT operation_json FROM ledger_proposals WHERE id = ?`)
          .get(proposalId) as { operation_json: string }).operation_json,
      ) as OperationInput;
      const planned = planOperation(db, op);
      const match = findMatchingAutoPostRule(db, {
        seller_id: proposal.seller_id,
        proposal_kind: planned.proposal_kind,
        fields: planned.auto_fields,
        ...(planned.auto_amount_cents !== undefined
          ? { amount_cents: planned.auto_amount_cents }
          : {}),
      });
      if (!match) {
        throw new LedgerError(
          'not_approved',
          `proposal '${proposalId}' requires seller approval before it can be ` +
            `posted, and no auto-post rule authorises it`,
        );
      }
      approvalBasis = 'auto_rule';
      autoRuleId = match.rule_id;
      autoMatchJson = JSON.stringify(match.evidence);
    }

    // ── 3 & 4. Re-plan and revalidate ───────────────────────────────────
    const operationJson = (
      db
        .prepare(`SELECT operation_json FROM ledger_proposals WHERE id = ?`)
        .get(proposalId) as { operation_json: string }
    ).operation_json;
    const op = JSON.parse(operationJson) as OperationInput;
    const planned = planOperation(db, op);
    revalidate(db, proposal.expected);

    // ── 5, 6, 7. Effects, journal, audit ────────────────────────────────
    const syncState = initialSyncStateForSeller(db, proposal.seller_id);
    const now = new Date().toISOString();

    const entryId = insertPostedEntry(db, {
      seller_id: proposal.seller_id,
      entry_date: planned.entry_date,
      memo: planned.memo,
      source_type: planned.source_type,
      source_id: planned.source_id,
      source_event_id: planned.source_event_id,
      idempotency_key: replayKey ?? null,
      reversal_of: null,
      entry_kind: 'standard',
      posted_by: actor.id,
      posted_at: now,
      lines: planned.preview.lines,
      external_sync_state: syncState,
    });

    const touchedInvoices = applyEffects(
      db,
      op,
      planned.source_event_id,
      entryId,
    );

    db.prepare(
      `UPDATE ledger_proposals
          SET status = 'posted', posted_entry_id = ?, approved_by = COALESCE(approved_by, ?),
              approved_at = COALESCE(approved_at, ?), approval_basis = ?,
              auto_rule_id = ?, auto_rule_match_json = ?
        WHERE id = ?`,
    ).run(
      entryId,
      approvalBasis === 'auto_rule' ? actor.id : null,
      approvalBasis === 'auto_rule' ? now : null,
      approvalBasis,
      autoRuleId,
      autoMatchJson,
      proposalId,
    );

    writeAuditEvent(db, {
      seller_id: proposal.seller_id,
      actor,
      action: 'ledger_entry.posted',
      entity_type: 'journal_entry',
      entity_id: entryId,
      detail: {
        proposal_id: proposalId,
        proposal_kind: planned.proposal_kind,
        approval_basis: approvalBasis,
        auto_rule_id: autoRuleId,
        source_event_id: planned.source_event_id,
        total_debit_cents: planned.preview.total_debit_cents,
        affected_invoices: planned.preview.affected_invoices.map((i) => ({
          invoice_id: i.invoice_id,
          number: i.number,
          before: i.balance_before_cents,
          after: i.balance_after_cents,
        })),
      },
    });

    // ── 8. Reminder recheck ─────────────────────────────────────────────
    // Settled invoices must not keep sending reminders, so this runs inside
    // the same transaction as the posting that settled them.
    const reminders: PostResult['reminders'] = [];
    for (const invoiceId of touchedInvoices) {
      const invoice = db
        .prepare(`SELECT * FROM invoices WHERE id = ?`)
        .get(invoiceId) as Parameters<typeof recheckReminderEligibility>[1] | undefined;
      if (!invoice) continue;
      const result = recheckReminderEligibility(db, invoice);
      if (result.suppressed.length > 0 || result.reinstated.length > 0) {
        reminders.push(result);
        writeAuditEvent(db, {
          seller_id: proposal.seller_id,
          actor,
          action: 'reminders.rechecked',
          entity_type: 'invoice',
          entity_id: invoiceId,
          detail: result,
        });
      }
    }

    const posted = getProposal(db, proposalId);
    if (!posted) throw new LedgerError('not_found', 'proposal vanished after post');

    return { proposal: posted, entry_id: entryId, replayed: false, reminders };
  });
}

// ─────────────────────────────── reverse ────────────────────────────────

export interface ReverseResult {
  entry_id: string;
  reversal_entry_id: string;
  reverses_entry_id: string;
  reminders: Array<{ invoice_id: string; suppressed: string[]; reinstated: string[] }>;
}

/**
 * Reverse a posted entry by posting its exact negation and flipping the
 * original's status.
 *
 * The original's lines are never touched — the schema's immutability trigger
 * would abort the transaction if they were. The only mutation to the original
 * is its status, which is what excludes its effects from every derived
 * balance in invoices.ts.
 *
 * Reversing a reversal is refused: that is what "correct mistakes through
 * linked reversals and replacement entries" means — you reverse, then post a
 * corrected entry, rather than stacking reversals.
 */
export function reverseLedgerEntry(
  db: Db,
  actor: Actor,
  entryId: string,
  reason: string,
): ReverseResult {
  return immediateTransaction(db, () => {
    const original = db
      .prepare(`SELECT * FROM journal_entries WHERE id = ?`)
      .get(entryId) as
      | {
          id: string;
          seller_id: string;
          entry_no: number;
          source_type: string;
          source_id: string;
          status: string;
          entry_kind: string;
          external_sync_state: string;
        }
      | undefined;

    if (!original) {
      throw new LedgerError('not_found', `journal entry '${entryId}' not found`);
    }
    assertSellerAccess(db, original.seller_id, actor);
    assertCanPost(db, original.seller_id, actor);

    if (!reason || reason.trim() === '') {
      throw new LedgerError(
        'validation',
        'a reason is required to reverse a posted entry',
      );
    }

    // Guard rails, then the plan.
    const plan = planReversal(db, original.seller_id, entryId);

    // A payment with live allocations cannot be reversed: the allocation
    // postings depend on it. Those must be reversed first.
    if (original.source_type === 'record_payment') {
      const active = db
        .prepare(
          `SELECT COUNT(*) AS n FROM payment_allocations
            WHERE payment_id = ? AND status = 'active'`,
        )
        .get(original.source_id) as { n: number };
      if (active.n > 0) {
        throw new LedgerError(
          'conflict',
          `cannot reverse a payment with ${active.n} active allocation(s); ` +
            `reverse those allocations first`,
        );
      }
    }

    const now = new Date().toISOString();
    const syncState = initialSyncStateForSeller(db, original.seller_id);

    // Build the reversal entry's lines.
    const built = plan.lines.map<ProposedLine>((line) => {
      const account = db
        .prepare(
          `SELECT id, code, name FROM gl_accounts WHERE seller_id = ? AND id = ?`,
        )
        .get(original.seller_id, line.account_id) as {
        id: string;
        code: string;
        name: string;
      };
      return {
        account_id: account.id,
        account_code: account.code,
        account_name: account.name,
        amount_cents: line.amount_cents,
        side: line.side,
        memo: `Reversal: ${reason}`,
      };
    });

    const reversalEntryId = insertPostedEntry(db, {
      seller_id: original.seller_id,
      entry_date: plan.entry_date,
      memo: plan.memo,
      source_type: 'reverse_entry',
      source_id: original.id,
      source_event_id: plan.source_event_id,
      idempotency_key: null,
      reversal_of: original.id,
      entry_kind: 'reversal',
      posted_by: actor.id,
      posted_at: now,
      lines: built,
      external_sync_state: syncState,
    });

    // Flip the original. The immutability trigger permits this single
    // transition and nothing else.
    db.prepare(
      `UPDATE journal_entries SET status = 'reversed' WHERE id = ?`,
    ).run(original.id);

    // Undo the subledger effects so derived balances follow the ledger.
    const touchedInvoices = reverseEffects(
      db,
      original.source_type,
      original.source_id,
    );

    writeAuditEvent(db, {
      seller_id: original.seller_id,
      actor,
      action: 'ledger_entry.reversed',
      entity_type: 'journal_entry',
      entity_id: original.id,
      detail: {
        reversal_entry_id: reversalEntryId,
        reason,
        original_entry_no: original.entry_no,
      },
    });

    const reminders: ReverseResult['reminders'] = [];
    for (const invoiceId of touchedInvoices) {
      const invoice = db
        .prepare(`SELECT * FROM invoices WHERE id = ?`)
        .get(invoiceId) as Parameters<typeof recheckReminderEligibility>[1] | undefined;
      if (!invoice) continue;
      const result = recheckReminderEligibility(db, invoice);
      if (result.suppressed.length > 0 || result.reinstated.length > 0) {
        reminders.push(result);
      }
    }

    return {
      entry_id: reversalEntryId,
      reversal_entry_id: reversalEntryId,
      reverses_entry_id: original.id,
      reminders,
    };
  });
}

/**
 * Undo a posting's subledger effects by flipping source-row statuses.
 *
 * Rows are never deleted — the schema forbids deleting allocations — so they
 * stay visible as history while dropping out of every derived sum.
 */
function reverseEffects(
  db: Db,
  sourceType: string,
  sourceId: string,
): string[] {
  const touched: string[] = [];

  switch (sourceType) {
    case 'allocate_payment': {
      const alloc = db
        .prepare(
          `SELECT id, payment_id, invoice_id, status FROM payment_allocations WHERE id = ?`,
        )
        .get(sourceId) as
        | { id: string; payment_id: string; invoice_id: string; status: string }
        | undefined;
      if (!alloc) break;
      if (alloc.status === 'active') {
        db.prepare(
          `UPDATE payment_allocations SET status = 'reversed' WHERE id = ?`,
        ).run(alloc.id);
      }
      recomputePaymentUnallocated(db, alloc.payment_id);
      recomputeInvoiceState(db, alloc.invoice_id);
      touched.push(alloc.invoice_id);
      break;
    }

    case 'apply_credit_note': {
      const note = db
        .prepare(`SELECT id, invoice_id, status FROM credit_notes WHERE id = ?`)
        .get(sourceId) as
        | { id: string; invoice_id: string | null; status: string }
        | undefined;
      if (!note) break;
      if (note.status === 'applied') {
        db.prepare(`UPDATE credit_notes SET status = 'reversed' WHERE id = ?`).run(
          note.id,
        );
      }
      if (note.invoice_id) {
        recomputeInvoiceState(db, note.invoice_id);
        touched.push(note.invoice_id);
      }
      break;
    }

    case 'record_refund': {
      const refund = db
        .prepare(`SELECT id, invoice_id, status FROM refunds WHERE id = ?`)
        .get(sourceId) as
        | { id: string; invoice_id: string | null; status: string }
        | undefined;
      if (!refund) break;
      if (refund.status === 'refunded') {
        db.prepare(`UPDATE refunds SET status = 'reversed' WHERE id = ?`).run(
          refund.id,
        );
      }
      if (refund.invoice_id) {
        recomputeInvoiceState(db, refund.invoice_id);
        touched.push(refund.invoice_id);
      }
      break;
    }

    case 'record_fee': {
      db.prepare(
        `UPDATE fees SET status = 'reversed' WHERE id = ? AND status = 'charged'`,
      ).run(sourceId);
      break;
    }

    case 'record_payment': {
      // Safe: the caller already verified there are no active allocations.
      db.prepare(
        `UPDATE payments SET status = 'reversed' WHERE id = ? AND status = 'confirmed'`,
      ).run(sourceId);
      recomputePaymentUnallocated(db, sourceId);
      break;
    }

    case 'post_adjustment': {
      const adj = db
        .prepare(`SELECT id, invoice_id, status FROM adjustments WHERE id = ?`)
        .get(sourceId) as
        | { id: string; invoice_id: string | null; status: string }
        | undefined;
      if (!adj) break;
      if (adj.status === 'posted') {
        db.prepare(`UPDATE adjustments SET status = 'reversed' WHERE id = ?`).run(
          adj.id,
        );
      }
      if (adj.invoice_id) {
        recomputeInvoiceState(db, adj.invoice_id);
        touched.push(adj.invoice_id);
      }
      break;
    }

    case 'issue_invoice': {
      // Voiding the invoice is the subledger consequence of reversing an
      // issuance. Refuse if anything has since been applied to it, because
      // those entries would be left pointing at a void invoice.
      const active = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM payment_allocations WHERE invoice_id = ? AND status='active') AS allocs,
             (SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status='applied') AS credits`,
        )
        .get(sourceId, sourceId) as { allocs: number; credits: number };
      if (active.allocs > 0 || active.credits > 0) {
        throw new LedgerError(
          'conflict',
          'cannot reverse an invoice issuance after payments or credit notes ' +
            'have been applied to it; reverse those first',
        );
      }
      db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).run(sourceId);
      touched.push(sourceId);
      break;
    }

    default:
      break;
  }

  return touched;
}

/** Entries available to reverse, for the UI's reversal picker. */
export function listReversibleEntries(db: Db, sellerId: string) {
  return listJournalEntries(db, { sellerId, limit: 200 }).filter(
    (e) => e.status === 'posted' && e.entry_kind === 'standard',
  );
}

/** Read one entry, scoped to the actor. */
export function getEntryForActor(db: Db, actor: Actor, entryId: string) {
  const entry = getJournalEntry(db, entryId);
  if (!entry) {
    throw new LedgerError('not_found', `journal entry '${entryId}' not found`);
  }
  assertSellerAccess(db, entry.seller_id, actor);
  return entry;
}

/**
 * Verify a payment's cached unallocated amount against its allocations.
 * Surfaced by the reconciliation interface rather than only used internally,
 * because a divergence here means a code path bypassed the recompute.
 */
export function auditPaymentConsistency(db: Db, paymentId: string) {
  const payment = requirePayment(
    db,
    (db.prepare(`SELECT seller_id FROM payments WHERE id = ?`).get(paymentId) as {
      seller_id: string;
    }).seller_id,
    paymentId,
  );
  const derived = deriveUnallocatedCents(db, paymentId);
  return {
    payment_id: paymentId,
    cached_unallocated_cents: payment.unallocated_cents,
    derived_unallocated_cents: derived,
    drift_cents: payment.unallocated_cents - derived,
  };
}
