/**
 * Auto-post rules.
 *
 * The requirement is staged deliberately: seller approval is required
 * initially, and automatic posting is only enabled later for explicitly
 * authorised, exact-match reconciliation rules. This module implements the
 * "later" half under restrictions that keep it honest:
 *
 *   - `match_mode` is pinned to 'exact' by a CHECK constraint. There is no
 *     fuzzy or partial matching, so a rule can never fire on a near-miss.
 *   - Every field listed in the rule's match_json must equal the operation's
 *     field exactly.
 *   - An optional `max_amount_cents` caps what the rule may post.
 *   - The rule must be explicitly `enabled`; creating one does not arm it.
 *   - The match evidence is stored on the proposal, so an auto-posted entry
 *     can always be explained after the fact.
 *
 * A rule that does not match is not an error — it just means the proposal
 * takes the manual approval path.
 */

import type { SqlDb } from '../db';
import { canonicalJson } from './ids';

export interface AutoPostRule {
  id: string;
  seller_id: string;
  name: string;
  enabled: number;
  proposal_kind: string;
  match_mode: 'exact';
  match_json: string;
  max_amount_cents: number | null;
  created_by: string;
  created_at: string;
}

export interface AutoRuleMatch {
  rule_id: string;
  rule_name: string;
  evidence: {
    matched_fields: Record<string, unknown>;
    amount_cents: number | null;
    max_amount_cents: number | null;
    match_mode: 'exact';
  };
}

export interface OperationShape {
  seller_id: string;
  proposal_kind: string;
  /** Fields the rule may match on. */
  fields: Record<string, unknown>;
  /** The amount the rule's cap applies to. */
  amount_cents?: number;
}

export async function listAutoPostRules(db: SqlDb, sellerId: string): Promise<AutoPostRule[]>{
  return await db.all(
      `SELECT * FROM auto_post_rules WHERE seller_id = ? ORDER BY created_at DESC`, [sellerId]) as AutoPostRule[];
}

/**
 * Find an enabled exact-match rule authorising this operation.
 *
 * Rules are evaluated in creation order and the first match wins, so the
 * matching is deterministic rather than dependent on row ordering.
 */
export async function findMatchingAutoPostRule(
  db: SqlDb,
  op: OperationShape,
): Promise<AutoRuleMatch | null>{
  const rules = await db.all(
      `SELECT * FROM auto_post_rules
        WHERE seller_id = ? AND proposal_kind = ? AND enabled = 1
        ORDER BY created_at, id`, [op.seller_id, op.proposal_kind]) as AutoPostRule[];

  for (const rule of rules) {
    let matcher: Record<string, unknown>;
    try {
      matcher = JSON.parse(rule.match_json) as Record<string, unknown>;
    } catch {
      // A malformed rule must never silently authorise a posting.
      continue;
    }
    const matcherKeys = Object.keys(matcher);
    if (matcherKeys.length === 0) {
      // An empty matcher would authorise every operation of its kind, which
      // is not "exact match" in any meaningful sense. Refuse to match.
      continue;
    }

    // Synchronous on purpose: `every` with an async callback returns a truthy
    // Promise regardless of the comparison result, so making this async would
    // make EVERY rule match every operation — silently bypassing the approval
    // requirement auto-post rules are supposed to be constrained by.
    const everyFieldMatches = matcherKeys.every((key) =>
      deepEqual(canonicalJson(matcher[key]), canonicalJson(op.fields[key])),
    );
    if (!everyFieldMatches) continue;

    if (
      rule.max_amount_cents !== null &&
      op.amount_cents !== undefined &&
      op.amount_cents > rule.max_amount_cents
    ) {
      // Over the rule's ceiling: falls through to manual approval.
      continue;
    }

    const matchedFields: Record<string, unknown> = {};
    for (const key of matcherKeys) matchedFields[key] = op.fields[key];

    return {
      rule_id: rule.id,
      rule_name: rule.name,
      evidence: {
        matched_fields: matchedFields,
        amount_cents: op.amount_cents ?? null,
        max_amount_cents: rule.max_amount_cents,
        match_mode: 'exact',
      },
    };
  }

  return null;
}

/** Pure comparison — no database access, so it stays synchronous. */
function deepEqual(a: string, b: string): boolean {
  return a === b;
}

export interface CreateAutoPostRuleInput {
  id: string;
  seller_id: string;
  name: string;
  proposal_kind: string;
  match: Record<string, unknown>;
  max_amount_cents?: number | null;
  enabled?: boolean;
  created_by: string;
}

export async function createAutoPostRule(db: SqlDb, input: CreateAutoPostRuleInput): Promise<void>{
  await db.run(
    `INSERT INTO auto_post_rules
       (id, seller_id, name, enabled, proposal_kind, match_mode, match_json,
        max_amount_cents, created_by)
     VALUES (?, ?, ?, ?, ?, 'exact', ?, ?, ?)`, [input.id, input.seller_id, input.name, input.enabled ? 1 : 0, input.proposal_kind, canonicalJson(input.match), input.max_amount_cents ?? null, input.created_by]);
}

export async function setAutoPostRuleEnabled(
  db: SqlDb,
  sellerId: string,
  ruleId: string,
  enabled: boolean,
): Promise<void>{
  await db.run(
    `UPDATE auto_post_rules SET enabled = ? WHERE seller_id = ? AND id = ?`, [enabled ? 1 : 0, sellerId, ruleId]);
}
