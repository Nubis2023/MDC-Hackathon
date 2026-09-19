/**
 * Append-only audit trail.
 *
 * Every state transition writes a row here, and the write happens inside the
 * same transaction as the change it describes. That is what makes the trail
 * trustworthy: an audit row exists if and only if the change it recorded was
 * committed.
 */

import type { SqlDb } from '../db';
import type { Actor } from '../domain/types';
import { newId } from './ids';

export interface AuditInput {
  seller_id: string;
  actor: Actor;
  action: string;
  entity_type: string;
  entity_id: string;
  detail?: unknown;
}

export async function writeAuditEvent(db: SqlDb, input: AuditInput): Promise<string>{
  const id = newId('aud');
  await db.run(
    `INSERT INTO audit_events
       (id, seller_id, actor_id, actor_kind, action, entity_type, entity_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.seller_id, input.actor.id, input.actor.kind, input.action, input.entity_type, input.entity_id, input.detail === undefined ? null : JSON.stringify(input.detail)]);
  return id;
}

export interface AuditEventRecord {
  id: string;
  seller_id: string;
  actor_id: string;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: unknown;
  created_at: string;
}

export async function listAuditEvents(
  db: SqlDb,
  sellerId: string,
  limit = 100,
): Promise<AuditEventRecord[]>{
  const rows = await db.all(
      `SELECT id, seller_id, actor_id, actor_kind, action, entity_type,
              entity_id, detail_json, created_at
         FROM audit_events
        WHERE seller_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`, [sellerId, limit]) as Array<{
    id: string;
    seller_id: string;
    actor_id: string;
    actor_kind: string;
    action: string;
    entity_type: string;
    entity_id: string;
    detail_json: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    seller_id: r.seller_id,
    actor_id: r.actor_id,
    actor_kind: r.actor_kind,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    // Postgres jsonb comes back already parsed; SQLite gives text.
    detail:
      r.detail_json === null
        ? null
        : typeof r.detail_json === 'string'
          ? JSON.parse(r.detail_json)
          : r.detail_json,
    created_at: r.created_at,
  }));
}
