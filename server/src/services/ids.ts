import { randomUUID, createHash } from 'node:crypto';

/**
 * Identifier helpers.
 *
 * Source event IDs are the primary duplicate-post defence: they are derived
 * from the business event itself (which payment, which invoice, which
 * allocation), so two requests describing the same event produce the same ID
 * and the second one hits a UNIQUE constraint instead of posting again.
 *
 * Idempotency keys are the caller's retry key. They are stored separately
 * because a client may retry a request while the underlying source event ID
 * stays identical — both paths must be blocked, and they are blocked at
 * different layers (service for idempotency, database for source events).
 */

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Deterministic id derived from a source event ID.
 *
 * Posting creates source rows (the payment, the allocation, the credit note).
 * Deriving their primary keys from the source event ID means a retried
 * request produces the *same* primary keys, so the second attempt collides on
 * the primary key rather than creating a duplicate record. Random IDs here
 * would defeat the idempotency guarantees the schema enforces.
 */
export function deterministicId(prefix: string, sourceEventId: string): string {
  const digest = createHash('sha256').update(sourceEventId).digest('hex');
  return `${prefix}_${digest.slice(0, 24)}`;
}

/**
 * Derive a source event ID from the semantic content of an operation.
 *
 * Two requests describing the same business event hash to the same ID, so the
 * duplicate is rejected by the UNIQUE(seller_id, source_event_id) constraint
 * without the caller having to supply a key. Callers that legitimately want to
 * post two identical-looking events (e.g. two separate $50 allocations from
 * one payment to one invoice) pass an explicit source_event_id instead.
 */
export function deriveSourceEventId(
  proposalKind: string,
  sellerId: string,
  semanticFields: Record<string, unknown>,
): string {
  const canonical = canonicalJson({ seller_id: sellerId, kind: proposalKind, ...semanticFields });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${proposalKind}:${digest.slice(0, 32)}`;
}

/** Stable JSON with sorted keys, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const sourceEventIds = {
  /** One posting per payment record. */
  payment: (sellerId: string, paymentId: string): string =>
    `payment:${sellerId}:${paymentId}`,

  /** One posting per allocation. Keyed by allocation id so two allocations
   *  of the same payment to the same invoice are distinct events. */
  paymentAllocation: (sellerId: string, allocationId: string): string =>
    `allocation:${sellerId}:${allocationId}`,

  creditNote: (sellerId: string, creditNoteId: string): string =>
    `credit_note:${sellerId}:${creditNoteId}`,

  fee: (sellerId: string, feeId: string): string =>
    `fee:${sellerId}:${feeId}`,

  refund: (sellerId: string, refundId: string): string =>
    `refund:${sellerId}:${refundId}`,

  adjustment: (sellerId: string, adjustmentId: string): string =>
    `adjustment:${sellerId}:${adjustmentId}`,

  /** A reversal is its own event, keyed off the entry it reverses, so an
   *  entry can be reversed exactly once (also enforced by a unique index). */
  reversal: (sellerId: string, entryId: string): string =>
    `reversal:${sellerId}:${entryId}`,
};
