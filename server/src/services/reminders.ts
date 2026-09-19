/**
 * Reminder eligibility.
 *
 * The requirement: recheck reminder eligibility after posting so settled
 * invoices are excluded from outstanding reminders. Reminders live in a queue
 * table rather than being fired immediately, which is what makes withdrawal
 * possible at all — a settled invoice's scheduled reminders are marked
 * 'suppressed' with a reason, and the state is visible in the UI.
 */

import type { Db } from '../db';
import type { InvoiceRecord } from '../domain/types';

export interface ReminderRecord {
  id: string;
  seller_id: string;
  invoice_id: string;
  kind: 'due_soon' | 'overdue' | 'final_notice';
  status: 'scheduled' | 'sent' | 'suppressed' | 'skipped_settled';
  scheduled_for: string;
  suppressed_reason: string | null;
}

export function listRemindersForInvoice(
  db: Db,
  invoiceId: string,
): ReminderRecord[] {
  return db
    .prepare(
      `SELECT * FROM reminders WHERE invoice_id = ?
        ORDER BY scheduled_for, rowid`,
    )
    .all(invoiceId) as ReminderRecord[];
}

export function listReminders(
  db: Db,
  sellerId: string,
  limit = 200,
): Array<ReminderRecord & { invoice_number: string; customer_name: string }> {
  return db
    .prepare(
      `SELECT r.*, i.number AS invoice_number, i.customer_name
         FROM reminders r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.seller_id = ?
        ORDER BY r.scheduled_for DESC, r.rowid DESC
        LIMIT ?`,
    )
    .all(sellerId, limit) as Array<
    ReminderRecord & { invoice_number: string; customer_name: string }
  >;
}

export interface ReminderRecheckResult {
  invoice_id: string;
  suppressed: string[];
  reinstated: string[];
}

/**
 * Re-evaluate one invoice's reminders against its live balance.
 *
 * Called after every posting that touches an invoice. An invoice with no
 * outstanding balance has no business sending a payment reminder, so any
 * scheduled reminder is suppressed. If a later posting (a refund reversal,
 * say) puts the invoice back into arrears, a suppressed reminder is
 * reinstated — hence the two directions.
 */
export function recheckReminderEligibility(
  db: Db,
  invoice: InvoiceRecord,
): ReminderRecheckResult {
  const suppressed: string[] = [];
  const reinstated: string[] = [];
  const settled = invoice.balance_cents <= 0 || invoice.status === 'void';

  const scheduled = db
    .prepare(
      `SELECT id, kind FROM reminders
        WHERE invoice_id = ? AND status = 'scheduled'`,
    )
    .all(invoice.id) as Array<{ id: string; kind: string }>;

  const suppressedRows = db
    .prepare(
      `SELECT id, kind, suppressed_reason FROM reminders
        WHERE invoice_id = ? AND status = 'suppressed'`,
    )
    .all(invoice.id) as Array<{
    id: string;
    kind: string;
    suppressed_reason: string | null;
  }>;

  const now = new Date().toISOString();

  if (settled) {
    const reason =
      invoice.status === 'void'
        ? 'invoice_voided'
        : 'invoice_settled';
    for (const r of scheduled) {
      db.prepare(
        `UPDATE reminders
            SET status = 'suppressed', suppressed_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).run(reason, now, r.id);
      suppressed.push(r.id);
    }
  } else {
    // Invoice is in arrears again: reinstate reminders that were only
    // suppressed because the invoice had looked settled.
    for (const r of suppressedRows) {
      if (
        r.suppressed_reason === 'invoice_settled' ||
        r.suppressed_reason === 'invoice_voided'
      ) {
        db.prepare(
          `UPDATE reminders
              SET status = 'scheduled', suppressed_reason = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(now, r.id);
        reinstated.push(r.id);
      }
    }
  }

  return { invoice_id: invoice.id, suppressed, reinstated };
}

/** Schedule the standard reminder ladder for a newly issued invoice. */
export function scheduleRemindersForInvoice(
  db: Db,
  invoice: InvoiceRecord,
): void {
  const due = new Date(`${invoice.due_date}T00:00:00Z`);
  const ladder: Array<{ kind: ReminderRecord['kind']; offsetDays: number }> = [
    { kind: 'due_soon', offsetDays: -3 },
    { kind: 'overdue', offsetDays: 1 },
    { kind: 'final_notice', offsetDays: 14 },
  ];
  const insert = db.prepare(
    `INSERT INTO reminders (id, seller_id, invoice_id, kind, status, scheduled_for)
     VALUES (?, ?, ?, ?, 'scheduled', ?)`,
  );
  for (const step of ladder) {
    const when = new Date(due);
    when.setUTCDate(when.getUTCDate() + step.offsetDays);
    insert.run(
      `rem_${invoice.id}_${step.kind}`,
      invoice.seller_id,
      invoice.id,
      step.kind,
      when.toISOString().slice(0, 10),
    );
  }
}

/** Reminders that would actually go out — the "outstanding reminders" view. */
export function listOutstandingReminders(
  db: Db,
  sellerId: string,
): Array<ReminderRecord & { invoice_number: string }> {
  return db
    .prepare(
      `SELECT r.*, i.number AS invoice_number
         FROM reminders r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.seller_id = ? AND r.status = 'scheduled'
        ORDER BY r.scheduled_for`,
    )
    .all(sellerId) as Array<ReminderRecord & { invoice_number: string }>;
}
