/**
 * External accounting platform synchronisation.
 *
 * The distinction this module exists to preserve: the local operational
 * ledger in this database and an external accounting platform are different
 * systems with different states. A posting is a fact about the local ledger
 * the moment it commits. Whether an external platform has been told about it
 * is a separate, weaker claim, and this module never lets the two be
 * confused.
 *
 * The rule enforced here: `journal_entries.external_sync_state` becomes
 * 'confirmed' only from a platform acknowledgement carrying a platform
 * reference. A local post sets it to 'pending' at most (and only when the
 * seller has declared an external authoritative system). Nothing in this
 * codebase writes 'confirmed' optimistically.
 */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type { ExternalSyncState } from '../domain/types';
import { writeAuditEvent } from './audit';
import { newId } from './ids';
import { getJournalEntry } from './journal';
import type { Actor } from '../domain/types';

export interface SyncAttemptRecord {
  id: string;
  seller_id: string;
  entry_id: string;
  platform: string;
  state: 'pending' | 'confirmed' | 'failed';
  external_ref: string | null;
  error_message: string | null;
  attempted_at: string;
  resolved_at: string | null;
}

/**
 * The sync state a freshly posted entry should carry.
 *
 * When the seller's authoritative system is 'local', external sync is not
 * applicable — there is no platform to be authoritative over these books.
 * When it is 'external', the local posting is provisional and the entry is
 * marked 'pending' until a platform ack arrives.
 */
export function initialSyncStateForSeller(
  db: Db,
  sellerId: string,
): ExternalSyncState {
  const row = db
    .prepare(`SELECT authoritative_system FROM sellers WHERE id = ?`)
    .get(sellerId) as { authoritative_system: string } | undefined;
  if (!row) {
    throw new LedgerError('not_found', `seller '${sellerId}' not found`);
  }
  return row.authoritative_system === 'external' ? 'pending' : 'not_applicable';
}

export interface RecordSyncAttemptInput {
  sellerId: string;
  entryId: string;
  platform: string;
  state: 'pending' | 'confirmed' | 'failed';
  externalRef?: string | null;
  request?: unknown;
  response?: unknown;
  errorMessage?: string | null;
  actor: Actor;
}

/**
 * Record an attempt to push a posted entry to an external platform.
 *
 * A 'confirmed' state REQUIRES an external_ref. Without a platform-issued
 * reference there is no evidence the platform accepted anything, so claiming
 * confirmation would be a fabricated reconciliation state. This is the single
 * hard gate that stops the system from asserting an external ledger was
 * updated when it was not.
 */
export function recordSyncAttempt(db: Db, input: RecordSyncAttemptInput): string {
  const entry = getJournalEntry(db, input.entryId);
  if (!entry) {
    throw new LedgerError('not_found', `journal entry '${input.entryId}' not found`);
  }
  if (entry.status !== 'posted') {
    throw new LedgerError(
      'validation',
      `cannot sync entry ${entry.entry_no}: it is '${entry.status}', not posted`,
    );
  }
  if (input.state === 'confirmed' && !input.externalRef) {
    throw new LedgerError(
      'validation',
      'a confirmed external sync requires a platform-issued external_ref; ' +
        'the external ledger must not be reported as updated without one',
    );
  }

  const id = newId('sync');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO external_sync_attempts
       (id, seller_id, entry_id, platform, state, external_ref, request_json,
        response_json, error_message, attempted_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sellerId,
    input.entryId,
    input.platform,
    input.state,
    input.externalRef ?? null,
    input.request === undefined ? null : JSON.stringify(input.request),
    input.response === undefined ? null : JSON.stringify(input.response),
    input.errorMessage ?? null,
    now,
    input.state === 'pending' ? null : now,
  );

  // The denormalised state on the entry mirrors the latest attempt. It is a
  // read convenience only — the attempt rows are the history of record.
  db.prepare(
    `UPDATE journal_entries
        SET external_sync_state = ?, external_ref = ?, external_synced_at = ?,
            external_error = ?
      WHERE id = ?`,
  ).run(
    input.state,
    input.state === 'confirmed' ? (input.externalRef ?? null) : null,
    input.state === 'confirmed' ? now : null,
    input.state === 'failed' ? (input.errorMessage ?? 'unknown error') : null,
    input.entryId,
  );

  writeAuditEvent(db, {
    seller_id: input.sellerId,
    actor: input.actor,
    action: `external_sync.${input.state}`,
    entity_type: 'journal_entry',
    entity_id: input.entryId,
    detail: {
      platform: input.platform,
      external_ref: input.externalRef ?? null,
      error: input.errorMessage ?? null,
    },
  });

  return id;
}

export function listSyncAttempts(
  db: Db,
  entryId: string,
): SyncAttemptRecord[] {
  return db
    .prepare(
      `SELECT id, seller_id, entry_id, platform, state, external_ref,
              error_message, attempted_at, resolved_at
         FROM external_sync_attempts
        WHERE entry_id = ?
        ORDER BY attempted_at DESC, rowid DESC`,
    )
    .all(entryId) as SyncAttemptRecord[];
}

/** Entries awaiting platform confirmation — the sync backlog view. */
export function listPendingSyncEntries(db: Db, sellerId: string) {
  return db
    .prepare(
      `SELECT id, entry_no, entry_date, memo, external_sync_state
         FROM journal_entries
        WHERE seller_id = ? AND external_sync_state = 'pending'
        ORDER BY entry_no`,
    )
    .all(sellerId) as Array<{
    id: string;
    entry_no: number;
    entry_date: string;
    memo: string;
    external_sync_state: string;
  }>;
}

export interface LedgerPosture {
  seller_id: string;
  authoritative_system: 'local' | 'external';
  local_ledger_is_authoritative: boolean;
  note: string;
}

/**
 * Explain, in the API response itself, which system is authoritative. The UI
 * renders this so an operator can never mistake a local posting for an
 * external ledger update.
 */
export function getLedgerPosture(db: Db, sellerId: string): LedgerPosture {
  const row = db
    .prepare(`SELECT authoritative_system FROM sellers WHERE id = ?`)
    .get(sellerId) as { authoritative_system: 'local' | 'external' } | undefined;
  if (!row) {
    throw new LedgerError('not_found', `seller '${sellerId}' not found`);
  }
  const local = row.authoritative_system === 'local';
  return {
    seller_id: sellerId,
    authoritative_system: row.authoritative_system,
    local_ledger_is_authoritative: local,
    note: local
      ? 'The local operational ledger is authoritative. No external accounting platform is connected.'
      : 'An external accounting platform is authoritative. Local postings are provisional until the platform confirms them.',
  };
}
