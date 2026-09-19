/**
 * Journal entry persistence and reading.
 *
 * Entries are always written in three steps, in this order, inside a caller's
 * transaction:
 *   1. INSERT the entry with status 'pending'
 *   2. INSERT its lines
 *   3. UPDATE status to 'posted'
 *
 * Step 3 is what trips the balance trigger in schema.sql, so an unbalanced
 * entry cannot become posted. There is no code path that inserts an entry
 * directly as 'posted', because at insert time the lines do not exist yet.
 */

import type { Db } from '../db';
import { LedgerError } from '../domain/errors';
import type {
  ExternalSyncState,
  JournalEntryRecord,
  JournalLineRecord,
  ProposedLine,
} from '../domain/types';
import { newId } from './ids';

export interface InsertEntryInput {
  seller_id: string;
  entry_date: string;
  memo: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  idempotency_key?: string | null;
  reversal_of?: string | null;
  entry_kind: 'standard' | 'reversal';
  posted_by: string;
  posted_at: string;
  lines: ProposedLine[];
  /** Set from the seller's authoritative_system at post time. */
  external_sync_state: ExternalSyncState;
}

/** Next per-seller entry number. Monotonic, gap-free per seller. */
function nextEntryNo(db: Db, sellerId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(entry_no), 0) AS max_no FROM journal_entries WHERE seller_id = ?`,
    )
    .get(sellerId) as { max_no: number };
  return row.max_no + 1;
}

/**
 * Insert a balanced entry and mark it posted. Must be called inside a
 * transaction; the balance trigger will abort the whole transaction if the
 * lines do not sum to zero.
 */
export function insertPostedEntry(db: Db, input: InsertEntryInput): string {
  const entryId = newId('je');
  const entryNo = nextEntryNo(db, input.seller_id);

  db.prepare(
    `INSERT INTO journal_entries
       (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
        source_event_id, idempotency_key, reversal_of, entry_kind, status,
        external_sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    entryId,
    input.seller_id,
    entryNo,
    input.entry_date,
    input.memo,
    input.source_type,
    input.source_id,
    input.source_event_id,
    input.idempotency_key ?? null,
    input.reversal_of ?? null,
    input.entry_kind,
    input.external_sync_state,
  );

  const insertLine = db.prepare(
    `INSERT INTO journal_lines
       (id, seller_id, entry_id, line_no, account_id, amount_cents, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  input.lines.forEach((line, index) => {
    insertLine.run(
      newId('jl'),
      input.seller_id,
      entryId,
      index + 1,
      line.account_id,
      line.side === 'debit' ? line.amount_cents : -line.amount_cents,
      line.memo ?? null,
    );
  });

  // Trip the balance trigger.
  db.prepare(
    `UPDATE journal_entries SET status = 'posted', posted_at = ?, posted_by = ? WHERE id = ?`,
  ).run(input.posted_at, input.posted_by, entryId);

  return entryId;
}

function loadLines(db: Db, entryId: string): JournalLineRecord[] {
  const rows = db
    .prepare(
      `SELECT l.line_no, l.account_id, l.amount_cents, l.memo,
              a.code AS account_code, a.name AS account_name
         FROM journal_lines l
         JOIN gl_accounts a ON a.seller_id = l.seller_id AND a.id = l.account_id
        WHERE l.entry_id = ?
        ORDER BY l.line_no`,
    )
    .all(entryId) as Array<{
    line_no: number;
    account_id: string;
    amount_cents: number;
    memo: string | null;
    account_code: string;
    account_name: string;
  }>;

  return rows.map((r) => ({
    line_no: r.line_no,
    account_id: r.account_id,
    account_code: r.account_code,
    account_name: r.account_name,
    amount_cents: r.amount_cents,
    side: r.amount_cents >= 0 ? 'debit' : 'credit',
    memo: r.memo,
  }));
}

export function getJournalEntry(db: Db, entryId: string): JournalEntryRecord | null {
  const row = db
    .prepare(`SELECT * FROM journal_entries WHERE id = ?`)
    .get(entryId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const lines = loadLines(db, entryId);
  const totalDebit = lines
    .filter((l) => l.side === 'debit')
    .reduce((a, l) => a + l.amount_cents, 0);
  const totalCredit = lines
    .filter((l) => l.side === 'credit')
    .reduce((a, l) => a + Math.abs(l.amount_cents), 0);

  return {
    id: row.id as string,
    seller_id: row.seller_id as string,
    entry_no: row.entry_no as number,
    entry_date: row.entry_date as string,
    memo: row.memo as string,
    source_type: row.source_type as string,
    source_id: row.source_id as string,
    source_event_id: row.source_event_id as string,
    idempotency_key: (row.idempotency_key as string | null) ?? null,
    reversal_of: (row.reversal_of as string | null) ?? null,
    entry_kind: row.entry_kind as 'standard' | 'reversal',
    status: row.status as 'pending' | 'posted' | 'reversed',
    posted_at: (row.posted_at as string | null) ?? null,
    posted_by: (row.posted_by as string | null) ?? null,
    external_sync_state: row.external_sync_state as ExternalSyncState,
    external_ref: (row.external_ref as string | null) ?? null,
    external_synced_at: (row.external_synced_at as string | null) ?? null,
    external_error: (row.external_error as string | null) ?? null,
    lines,
    total_debit_cents: totalDebit,
    total_credit_cents: totalCredit,
    balanced: totalDebit === totalCredit && totalDebit > 0,
  };
}

export function getJournalEntryBySourceEvent(
  db: Db,
  sellerId: string,
  sourceEventId: string,
): JournalEntryRecord | null {
  const row = db
    .prepare(
      `SELECT id FROM journal_entries WHERE seller_id = ? AND source_event_id = ?`,
    )
    .get(sellerId, sourceEventId) as { id: string } | undefined;
  return row ? getJournalEntry(db, row.id) : null;
}

export function getJournalEntryByIdempotencyKey(
  db: Db,
  sellerId: string,
  idempotencyKey: string,
): JournalEntryRecord | null {
  const row = db
    .prepare(
      `SELECT id FROM journal_entries WHERE seller_id = ? AND idempotency_key = ?`,
    )
    .get(sellerId, idempotencyKey) as { id: string } | undefined;
  return row ? getJournalEntry(db, row.id) : null;
}

export interface ListEntriesOptions {
  sellerId: string;
  limit?: number;
  sourceType?: string;
}

export function listJournalEntries(
  db: Db,
  options: ListEntriesOptions,
): JournalEntryRecord[] {
  const limit = options.limit ?? 100;
  const rows = options.sourceType
    ? (db
        .prepare(
          `SELECT id FROM journal_entries
            WHERE seller_id = ? AND source_type = ?
            ORDER BY entry_no DESC LIMIT ?`,
        )
        .all(options.sellerId, options.sourceType, limit) as Array<{ id: string }>)
    : (db
        .prepare(
          `SELECT id FROM journal_entries
            WHERE seller_id = ?
            ORDER BY entry_no DESC LIMIT ?`,
        )
        .all(options.sellerId, limit) as Array<{ id: string }>);

  return rows
    .map((r) => getJournalEntry(db, r.id))
    .filter((e): e is JournalEntryRecord => e !== null);
}

/** Throw unless the entry exists and is still posted (i.e. not reversed). */
export function requireReversibleEntry(
  db: Db,
  entryId: string,
): JournalEntryRecord {
  const entry = getJournalEntry(db, entryId);
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
  return entry;
}
