/**
 * Manual adjustments.
 *
 * An adjustment is the operator's escape hatch for things the other
 * operations do not cover (a write-off, a goodwill credit, a surcharge). It
 * is also the operation most in need of a control, so the path is explicit:
 *
 *   draft ──approve──▶ approved ──post──▶ posted ──reverse──▶ reversed
 *
 * An adjustment can only be posted from 'approved', and the database CHECK
 * constraint refuses to represent an approved row without an approver. The
 * approver must be a different human from the creator — the same
 * no-self-approval principle that governs proposals.
 */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type { Actor } from '../domain/types';
import { assertCanApprove, assertSellerAccess } from './access';
import { writeAuditEvent } from './audit';
import { newId } from './ids';

export interface AdjustmentRecord {
  id: string;
  seller_id: string;
  invoice_id: string | null;
  amount_cents: number;
  direction: 'debit' | 'credit';
  mapping_key: string;
  memo: string;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  status: 'draft' | 'approved' | 'posted' | 'reversed';
  created_at: string;
}

export function getAdjustment(
  db: Db,
  sellerId: string,
  adjustmentId: string,
): AdjustmentRecord | null {
  const row = db
    .prepare(`SELECT * FROM adjustments WHERE id = ? AND seller_id = ?`)
    .get(adjustmentId, sellerId) as AdjustmentRecord | undefined;
  return row ?? null;
}

export function listAdjustments(db: Db, sellerId: string): AdjustmentRecord[] {
  return db
    .prepare(
      `SELECT * FROM adjustments WHERE seller_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(sellerId) as AdjustmentRecord[];
}

export interface CreateAdjustmentInput {
  seller_id: string;
  invoice_id?: string | null;
  amount_cents: number;
  direction: 'debit' | 'credit';
  mapping_key: string;
  memo: string;
}

export function createAdjustment(
  db: Db,
  actor: Actor,
  input: CreateAdjustmentInput,
): AdjustmentRecord {
  assertSellerAccess(db, input.seller_id, actor);

  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
    throw new LedgerError(
      'validation',
      'adjustment amount must be a positive integer number of cents',
    );
  }
  if (!input.memo || input.memo.trim() === '') {
    throw new LedgerError('validation', 'an adjustment requires a memo');
  }
  if (input.direction !== 'debit' && input.direction !== 'credit') {
    throw new LedgerError(
      'validation',
      "adjustment direction must be 'debit' (write-off) or 'credit' (surcharge)",
    );
  }

  // The mapping key must exist for both sides, otherwise the adjustment
  // cannot produce a balanced entry later.
  const mapping = db
    .prepare(
      `SELECT COUNT(*) AS n FROM account_mappings
        WHERE seller_id = ? AND mapping_key = ?`,
    )
    .get(input.seller_id, input.mapping_key) as { n: number };
  if (mapping.n === 0) {
    throw new LedgerError(
      'validation',
      `no account mapping configured for key '${input.mapping_key}'`,
    );
  }

  if (input.invoice_id) {
    const invoice = db
      .prepare(`SELECT id FROM invoices WHERE id = ? AND seller_id = ?`)
      .get(input.invoice_id, input.seller_id) as { id: string } | undefined;
    if (!invoice) {
      throw new LedgerError('not_found', `invoice '${input.invoice_id}' not found`);
    }
  }

  const id = newId('adj');
  db.prepare(
    `INSERT INTO adjustments
       (id, seller_id, invoice_id, amount_cents, direction, mapping_key, memo,
        created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
  ).run(
    id,
    input.seller_id,
    input.invoice_id ?? null,
    input.amount_cents,
    input.direction,
    input.mapping_key,
    input.memo,
    actor.id,
  );

  writeAuditEvent(db, {
    seller_id: input.seller_id,
    actor,
    action: 'adjustment.created',
    entity_type: 'adjustment',
    entity_id: id,
    detail: {
      amount_cents: input.amount_cents,
      direction: input.direction,
      mapping_key: input.mapping_key,
      invoice_id: input.invoice_id ?? null,
      memo: input.memo,
    },
  });

  const created = getAdjustment(db, input.seller_id, id);
  if (!created) throw new LedgerError('not_found', 'adjustment vanished');
  return created;
}

/** Approve a draft adjustment. Human approver, not the creator. */
export function approveAdjustment(
  db: Db,
  actor: Actor,
  sellerId: string,
  adjustmentId: string,
): AdjustmentRecord {
  const adjustment = getAdjustment(db, sellerId, adjustmentId);
  if (!adjustment) {
    throw new LedgerError('not_found', `adjustment '${adjustmentId}' not found`);
  }

  if (actor.kind === 'agent') {
    throw new LedgerError(
      'self_approval',
      'an agent may not approve an adjustment; approval must come from a seller user',
    );
  }
  if (adjustment.created_by === actor.id) {
    throw new LedgerError(
      'self_approval',
      'an adjustment cannot be approved by the actor that created it',
    );
  }
  assertCanApprove(db, sellerId, actor);

  if (adjustment.status === 'approved') return adjustment;
  if (adjustment.status !== 'draft') {
    throw new LedgerError(
      'conflict',
      `adjustment '${adjustmentId}' is '${adjustment.status}' and cannot be approved`,
    );
  }

  db.prepare(
    `UPDATE adjustments SET status = 'approved', approved_by = ?, approved_at = ?
      WHERE id = ?`,
  ).run(actor.id, new Date().toISOString(), adjustmentId);

  writeAuditEvent(db, {
    seller_id: sellerId,
    actor,
    action: 'adjustment.approved',
    entity_type: 'adjustment',
    entity_id: adjustmentId,
    detail: { approved_by: actor.id },
  });

  const updated = getAdjustment(db, sellerId, adjustmentId);
  if (!updated) throw new LedgerError('not_found', 'adjustment vanished');
  return updated;
}
