/**
 * Reminder eligibility.
 *
 * The requirement: recheck reminder eligibility after posting so settled
 * invoices are excluded from outstanding reminders. Reminders live in a queue
 * table rather than being fired immediately, which is what makes withdrawal
 * possible at all — a settled invoice's scheduled reminders are marked
 * 'suppressed' with a reason, and the state is visible in the UI.
 */

import type { SqlDb } from '../db';
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

export async function listRemindersForInvoice(
  db: SqlDb,
  invoiceId: string,
): Promise<ReminderRecord[]>{
  return await db.all(
      `SELECT * FROM reminders WHERE invoice_id = ?
        ORDER BY scheduled_for, id`, [invoiceId]) as ReminderRecord[];
}

export async function listReminders(
  db: SqlDb,
  sellerId: string,
  limit = 200,
): Promise<Array<ReminderRecord & { invoice_number: string; customer_name: string }>>{
  return await db.all(
      `SELECT r.*, i.number AS invoice_number, i.customer_name
         FROM reminders r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.seller_id = ?
        ORDER BY r.scheduled_for DESC, r.id DESC
        LIMIT ?`, [sellerId, limit]) as Array<
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
export async function recheckReminderEligibility(
  db: SqlDb,
  invoice: InvoiceRecord,
): Promise<ReminderRecheckResult>{
  const suppressed: string[] = [];
  const reinstated: string[] = [];
  const settled = invoice.balance_cents <= 0 || invoice.status === 'void';

  const scheduled = await db.all(
      `SELECT id, kind FROM reminders
        WHERE invoice_id = ? AND status = 'scheduled'`, [invoice.id]) as Array<{ id: string; kind: string }>;

  const suppressedRows = await db.all(
      `SELECT id, kind, suppressed_reason FROM reminders
        WHERE invoice_id = ? AND status = 'suppressed'`, [invoice.id]) as Array<{
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
      await db.run(
        `UPDATE reminders
            SET status = 'suppressed', suppressed_reason = ?, updated_at = ?
          WHERE id = ?`, [reason, now, r.id]);
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
        await db.run(
          `UPDATE reminders
              SET status = 'scheduled', suppressed_reason = NULL, updated_at = ?
            WHERE id = ?`, [now, r.id]);
        reinstated.push(r.id);
      }
    }
  }

  return { invoice_id: invoice.id, suppressed, reinstated };
}

/** Schedule the standard reminder ladder for a newly issued invoice. */
export async function scheduleRemindersForInvoice(
  db: SqlDb,
  invoice: InvoiceRecord,
): Promise<void>{
  const due = new Date(`${invoice.due_date}T00:00:00Z`);
  const ladder: Array<{ kind: ReminderRecord['kind']; offsetDays: number }> = [
    { kind: 'due_soon', offsetDays: -3 },
    { kind: 'overdue', offsetDays: 1 },
    { kind: 'final_notice', offsetDays: 14 },
  ];
  // No prepared-handle reuse: the async interface has no prepare().
  for (const step of ladder) {
    const when = new Date(due);
    when.setUTCDate(when.getUTCDate() + step.offsetDays);
    await db.run(
      `INSERT INTO reminders (id, seller_id, invoice_id, kind, status, scheduled_for)
       VALUES (?, ?, ?, ?, 'scheduled', ?)`,
      [
      `rem_${invoice.id}_${step.kind}`,
      invoice.seller_id,
      invoice.id,
      step.kind,
      when.toISOString().slice(0, 10),
      ],
    );
  }
}

/** Reminders that would actually go out — the "outstanding reminders" view. */
export async function listOutstandingReminders(
  db: SqlDb,
  sellerId: string,
): Promise<Array<ReminderRecord & { invoice_number: string }>>{
  return await db.all(
      `SELECT r.*, i.number AS invoice_number
         FROM reminders r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.seller_id = ? AND r.status = 'scheduled'
        ORDER BY r.scheduled_for`, [sellerId]) as Array<ReminderRecord & { invoice_number: string }>;
}
