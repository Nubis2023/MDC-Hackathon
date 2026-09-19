/**
 * External accounting platform sync.
 *
 * This view exists to keep one distinction unmistakable: a locally posted
 * entry is not an external ledger update. Sync state is shown per entry, and
 * the interface only ever displays "confirmed" after the platform has
 * supplied a reference back.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, money, parseMoney, type JournalEntry } from './api';
import { Badge, Empty, ErrorBanner, OkBanner, Panel, SyncState } from './ui';

interface Props {
  sellerId: string;
  revision: number;
}

export function SyncView({ sellerId, revision }: Props) {
  const [posture, setPosture] = useState<{ authoritative_system: string; note: string } | null>(null);
  const [pending, setPending] = useState<
    Array<{ id: string; entry_no: number; memo: string; external_sync_state: string }>
  >([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [sync, journal] = await Promise.all([
        api.sync(sellerId),
        api.journal(sellerId),
      ]);
      setPosture(sync.posture);
      setPending(sync.pending);
      setEntries(journal.entries);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const attempt = async (
    entryId: string,
    state: 'pending' | 'confirmed' | 'failed',
  ) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.syncAttempt(entryId, {
        state,
        external_ref: state === 'confirmed' ? refs[entryId] || undefined : undefined,
        error_message: state === 'failed' ? 'platform returned 503' : undefined,
      });
      setOk(
        state === 'confirmed'
          ? 'Sync recorded as confirmed against the platform reference. The external ledger is now known to hold this entry.'
          : state === 'failed'
            ? 'Sync failure recorded. The local posting still stands — a sync failure is not a ledger failure.'
            : 'Sync recorded as pending.',
      );
      await refresh();
    } catch (err) {
      const e = err as { message: string; code?: string };
      setError({ message: e.message, code: e.code });
    } finally {
      setBusy(false);
    }
  };

  const syncable = entries.filter((e) => e.status === 'posted');

  return (
    <div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {ok ? <OkBanner>{ok}</OkBanner> : null}

      {posture ? (
        <div
          className={`banner ${posture.authoritative_system === 'local' ? 'info' : 'warn'}`}
        >
          <strong>
            Authoritative system: {posture.authoritative_system}
          </strong>
          {posture.note} The interface never reports the external ledger as updated until the
          platform confirms it with a reference.
        </div>
      ) : null}

      <Panel
        title={`Awaiting external confirmation (${pending.length})`}
        hint="Posted locally, not yet acknowledged by the accounting platform."
      >
        {pending.length === 0 ? (
          <Empty>
            Nothing pending. Either the local ledger is authoritative, or every entry has been
            resolved.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Memo</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td className="mono">#{p.entry_no}</td>
                  <td>{p.memo}</td>
                  <td>
                    <SyncState state={p.external_sync_state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Simulate a platform response"
        hint="Stands in for the connected accounting platform. A 'confirmed' response requires a platform reference — the backend refuses to record confirmation without one."
        actions={<button className="ghost" onClick={() => void refresh()}>refresh</button>}
      >
        {syncable.length === 0 ? (
          <Empty>No posted entries to sync.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Memo</th>
                <th>Sync state</th>
                <th>Platform reference</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {syncable.map((e) => (
                <tr key={e.id}>
                  <td className="mono">#{e.entry_no}</td>
                  <td className="small">{e.memo}</td>
                  <td>
                    <SyncState state={e.external_sync_state} />
                    {e.external_ref ? (
                      <div className="mono muted small">{e.external_ref}</div>
                    ) : null}
                  </td>
                  <td>
                    <input
                      placeholder="PLATFORM-JE-…"
                      value={refs[e.id] ?? ''}
                      onChange={(ev) =>
                        setRefs((prev) => ({ ...prev, [e.id]: ev.target.value }))
                      }
                    />
                  </td>
                  <td>
                    <div className="inline">
                      <button disabled={busy} onClick={() => void attempt(e.id, 'pending')}>
                        Mark pending
                      </button>
                      <button
                        className="primary"
                        disabled={busy || !refs[e.id]}
                        title={
                          refs[e.id]
                            ? undefined
                            : 'Enter the platform reference first — confirmation without one is refused'
                        }
                        onClick={() => void attempt(e.id, 'confirmed')}
                      >
                        Confirm
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void attempt(e.id, 'failed')}
                      >
                        Mark failed
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

/**
 * Adjustments: the manual write-off / surcharge path, with its own creator ≠
 * approver rule.
 */
export function AdjustmentsView({ sellerId, currency, revision }: Props & { currency: string }) {
  const [adjustments, setAdjustments] = useState<
    Array<{
      id: string;
      invoice_id: string | null;
      amount_cents: number;
      direction: string;
      mapping_key: string;
      memo: string;
      status: string;
      approved_by: string | null;
    }>
  >([]);
  const [invoices, setInvoices] = useState<Array<{ id: string; number: string }>>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('250.00');
  const [memo, setMemo] = useState('Goodwill write-off');
  const [direction, setDirection] = useState<'debit' | 'credit'>('debit');
  const [invoiceId, setInvoiceId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [adj, inv] = await Promise.all([
        api.adjustments(sellerId),
        api.invoices(sellerId),
      ]);
      setAdjustments(adj.adjustments);
      setInvoices(inv.invoices);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.createAdjustment(sellerId, {
        invoice_id: invoiceId || null,
        amount_cents: parseMoney(amount),
        direction,
        mapping_key: 'adjustment',
        memo,
      });
      setOk('Draft adjustment created. It must be approved by a different user before it can be posted.');
      await refresh();
    } catch (err) {
      const e = err as { message: string; code?: string };
      setError({ message: e.message, code: e.code });
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.approveAdjustment(sellerId, id);
      setOk('Adjustment approved. Raise a post_adjustment proposal to put it on the ledger.');
      await refresh();
    } catch (err) {
      const e = err as { message: string; code?: string };
      setError({ message: e.message, code: e.code });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {ok ? <OkBanner>{ok}</OkBanner> : null}

      <Panel
        title="Create an adjustment"
        hint="A draft is not postable. Approval must come from a different user, and the database refuses to represent an approved adjustment without an approver."
      >
        <div className="row">
          <div className="col">
            <label className="small muted">Amount (USD)</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="col">
            <label className="small muted">Direction</label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'debit' | 'credit')}
            >
              <option value="debit">debit — write-off (reduces the balance)</option>
              <option value="credit">credit — surcharge (increases the balance)</option>
            </select>
          </div>
          <div className="col">
            <label className="small muted">Invoice (optional)</label>
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">No specific invoice</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number}
                </option>
              ))}
            </select>
          </div>
          <div className="col">
            <label className="small muted">Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
        <div className="inline" style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy} onClick={() => void create()}>
            Create draft
          </button>
        </div>
      </Panel>

      <Panel title="Adjustments">
        <table>
          <thead>
            <tr>
              <th>Memo</th>
              <th>Direction</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Approved by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <td>{a.memo}</td>
                <td className="muted small">{a.direction}</td>
                <td className="num">{money(a.amount_cents, currency)}</td>
                <td>
                  <Badge
                    tone={
                      a.status === 'posted'
                        ? 'green'
                        : a.status === 'approved'
                          ? 'blue'
                          : a.status === 'reversed'
                            ? 'red'
                            : 'amber'
                    }
                  >
                    {a.status}
                  </Badge>
                </td>
                <td className="mono small">{a.approved_by ?? '—'}</td>
                <td>
                  {a.status === 'draft' ? (
                    <button disabled={busy} onClick={() => void approve(a.id)}>
                      Approve
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {adjustments.length === 0 ? <Empty>No adjustments.</Empty> : null}
      </Panel>
    </div>
  );
}
