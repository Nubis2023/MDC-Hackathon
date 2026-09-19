/**
 * Reminders and the audit trail.
 *
 * The reminders view exists to make the settlement rule observable: a settled
 * invoice's reminders are suppressed with a reason, and a refund or reversed
 * allocation puts them back.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, timestamp, type AuditEvent, type Reminder } from './api';
import { Badge, Empty, ErrorBanner, Panel, ReminderStatus } from './ui';

interface RemindersProps {
  sellerId: string;
  /** Bumped by the parent after a posting so the view refetches. */
  revision: number;
}

export function RemindersView({ sellerId, revision }: RemindersProps) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [outstanding, setOutstanding] = useState<Reminder[]>([]);
  const [error, setError] = useState<{ message: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.reminders(sellerId);
      setReminders(res.reminders);
      setOutstanding(res.outstanding);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  return (
    <div>
      <ErrorBanner error={error} />
      <div className="banner info">
        <strong>Reminder eligibility is rechecked after every posting</strong>
        An invoice with no outstanding balance is excluded from reminders. Suppression happens
        inside the same transaction as the posting that settled it, so a settled invoice cannot
        slip a reminder out in between.
      </div>

      <Panel
        title={`Outstanding reminders (${outstanding.length})`}
        hint="What would actually go out. Settled invoices are absent by construction."
      >
        {outstanding.length === 0 ? (
          <Empty>Nothing outstanding — every invoice is either settled or void.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Kind</th>
                <th>Scheduled for</th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.invoice_number}</td>
                  <td>{r.kind.replace('_', ' ')}</td>
                  <td className="small">{r.scheduled_for}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="All reminders"
        hint="Includes suppressed ones, with the reason — suppression is recorded, not silently dropped."
        actions={<button className="ghost" onClick={() => void refresh()}>refresh</button>}
      >
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Kind</th>
              <th>Scheduled for</th>
              <th>Status</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.invoice_number}</td>
                <td>{r.kind.replace('_', ' ')}</td>
                <td className="small muted">{r.scheduled_for}</td>
                <td>
                  <ReminderStatus status={r.status} />
                </td>
                <td className="small muted">
                  {r.suppressed_reason ? r.suppressed_reason.replace(/_/g, ' ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reminders.length === 0 ? <Empty>No reminders.</Empty> : null}
      </Panel>
    </div>
  );
}

export function AuditView({ sellerId, revision }: RemindersProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<{ message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .audit(sellerId)
      .then((res) => {
        if (!cancelled) setEvents(res.events);
      })
      .catch((err: Error) => {
        if (!cancelled) setError({ message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [sellerId, revision]);

  const tone = (action: string): 'green' | 'red' | 'amber' | 'blue' | 'gray' => {
    if (action.includes('posted')) return 'green';
    if (action.includes('reversed') || action.includes('rejected')) return 'red';
    if (action.includes('approved')) return 'blue';
    if (action.includes('failed')) return 'red';
    if (action.includes('confirmed')) return 'green';
    return 'gray';
  };

  return (
    <div>
      <ErrorBanner error={error} />
      <Panel
        title="Audit trail"
        hint="Append-only. Each entry is written inside the same transaction as the change it records, so a row exists if and only if the change committed."
      >
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="small muted">{timestamp(e.created_at)}</td>
                <td className="mono small">
                  {e.actor_id}
                  <div className="muted">{e.actor_kind}</div>
                </td>
                <td>
                  <Badge tone={tone(e.action)}>{e.action}</Badge>
                </td>
                <td className="mono small">
                  {e.entity_type}
                  <div className="muted">{e.entity_id.slice(0, 12)}</div>
                </td>
                <td className="small">
                  {e.detail ? (
                    <details>
                      <summary className="muted" style={{ cursor: 'pointer' }}>
                        view
                      </summary>
                      <pre className="pre" style={{ marginTop: 6 }}>
                        {JSON.stringify(e.detail, null, 2)}
                      </pre>
                    </details>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 ? <Empty>No audit events.</Empty> : null}
      </Panel>
    </div>
  );
}
