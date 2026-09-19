/**
 * Seller access control.
 *
 * The requirement: every financial record carries a seller ID, and the
 * acting user or agent's access to that seller is validated. This is the
 * single choke point for that check — every service entry point calls
 * `assertSellerAccess` before touching a row, and the agent tools call it via
 * the same service layer, so an agent cannot reach a seller its principal
 * could not.
 *
 * On Supabase this is also backed by row level security (see
 * supabase/migrations). RLS is the *second* line of defence, not the first:
 * the backend connects with the service role, which bypasses RLS. These
 * checks are what actually run on every request.
 */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type { Actor, MembershipRole } from '../domain/types';

export interface Membership {
  seller_id: string;
  user_id: string;
  role: MembershipRole;
}

/** Roles permitted to approve a posting on the seller's behalf. */
const APPROVER_ROLES: MembershipRole[] = ['owner', 'approver'];
/** Roles permitted to post (posting requires prior approval, checked separately). */
const POSTER_ROLES: MembershipRole[] = ['owner', 'approver', 'bookkeeper'];

export function getMembership(
  db: Db,
  sellerId: string,
  userId: string,
): Membership | null {
  const row = db
    .prepare(
      `SELECT seller_id, user_id, role FROM seller_memberships
        WHERE seller_id = ? AND user_id = ?`,
    )
    .get(sellerId, userId) as Membership | undefined;
  return row ?? null;
}

/**
 * Assert the actor has *any* access to the seller. Absence of a membership is
 * a 403, and it is intentionally indistinguishable from "seller does not
 * exist" in the response body so the API does not leak which seller IDs
 * exist to an unauthorised caller.
 */
export function assertSellerAccess(db: Db, sellerId: string, actor: Actor): Membership {
  if (!sellerId || typeof sellerId !== 'string') {
    throw new LedgerError('validation', 'seller_id is required on every financial record');
  }
  const membership = getMembership(db, sellerId, actor.id);
  if (!membership) {
    throw new LedgerError(
      'forbidden',
      `actor '${actor.id}' has no access to seller '${sellerId}'`,
    );
  }
  return membership;
}

export function assertRole(
  membership: Membership,
  allowed: MembershipRole[],
  action: string,
): void {
  if (!allowed.includes(membership.role)) {
    throw new LedgerError(
      'forbidden',
      `role '${membership.role}' is not permitted to ${action}`,
    );
  }
}

/** Assert the actor holds a role that may approve postings. */
export function assertCanApprove(db: Db, sellerId: string, actor: Actor): Membership {
  const membership = assertSellerAccess(db, sellerId, actor);
  assertRole(membership, APPROVER_ROLES, 'approve ledger updates');
  return membership;
}

/** Assert the actor holds a role that may post. */
export function assertCanPost(db: Db, sellerId: string, actor: Actor): Membership {
  const membership = assertSellerAccess(db, sellerId, actor);
  assertRole(membership, POSTER_ROLES, 'post ledger updates');
  return membership;
}

/**
 * Seller ids the actor can see. Used by the reconciliation interface to scope
 * its listing queries.
 */
export function accessibleSellerIds(db: Db, actor: Actor): string[] {
  const rows = db
    .prepare(`SELECT seller_id FROM seller_memberships WHERE user_id = ?`)
    .all(actor.id) as Array<{ seller_id: string }>;
  return rows.map((r) => r.seller_id);
}
