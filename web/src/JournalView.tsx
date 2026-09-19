/**
 * Journal view: posted entries, their lines, and reversal.
 *
 * Reversal is the only mutation available here, because posted entries are
 * immutable — the correct way to fix a mistake is a linked reversal plus a
 * replacement entry, not an edit.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, money, timestamp, type JournalEntry } from './api';
import { Badge, Empty, ErrorBanner, OkBanner, Panel, SyncState } from './ui';

interface Props {
  sellerId: string;
  currency: string;
  onLedgerChange: () => void;
}

export function JournalView({ sellerId, currency, onLedgerChange }: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await api.journal(sellerId);
      setEntries(res.entries);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reverse = async (entryId: string) => {
    const reason = reasons[entryId]?.trim();
    if (!reason) {
      setError({ message: 'Enter a reason before reversing — the audit trail requires one.' });
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await api.reverse(entryId, reason);
      if (res.ok === false) {
        setError({ message: res.error?.message ?? 'reversal refused' });
      } else {
        setOk(
          'Reversal posted. The original entry is now marked reversed and its effect is excluded from every balance — its lines were not modified.',
        );
        await refresh();
        onLedgerChange();
      }
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

      <div className="banner info">
        <strong>Posted entries are immutable</strong>
        Lines and memos cannot be edited or deleted — the database refuses it. Mistakes are
        corrected with a linked reversal and, where needed, a replacement entry. A reversal is
        itself an entry, so it reverses exactly once and can never be reversed again.
      </div>

      <Panel title="Journal" actions={<button className="ghost" onClick={() => void refresh()}>refresh</button>}>
        {entries.length === 0 ? <Empty>No journal entries yet.</Empty> : null}
        <div className="stack">
          {entries.map((entry) => (
            <div
              key={entry.id}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                background: 'var(--panel-2)',
              }}
            >
              <div className="inline" style={{ marginBottom: 8 }}>
                <strong className="mono">#{entry.entry_no}</strong>
                <span>{entry.memo}</span>
                <span className="right inline">
                  {entry.entry_kind === 'reversal' ? (
                    <Badge tone="amber">reversal</Badge>
                  ) : null}
                  {entry.status === 'reversed' ? (
                    <Badge tone="gray">reversed</Badge>
                  ) : (
                    <Badge tone="green">posted</Badge>
                  )}
                  <SyncState state={entry.external_sync_state} />
                </span>
              </div>

              <div className="muted small" style={{ marginBottom: 8 }}>
                {entry.entry_date} · {entry.source_type.replace('_', ' ')} · posted by{' '}
                <span className="mono">{entry.posted_by}</span>
                {entry.posted_at ? ` at ${timestamp(entry.posted_at)}` : ''}
                {entry.reversal_of ? ' · reverses ' + entry.reversal_of.slice(0, 14) : ''}
              </div>

              <table>
                <thead>
                  <tr>
                    <th style={{ width: '50%' }}>Account</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line) => (
                    <tr key={line.line_no}>
                      <td>
                        <span className="mono">{line.account_code}</span> {line.account_name}
                        {line.memo ? <div className="muted small">{line.memo}</div> : null}
                      </td>
                      <td className="num line dr">
                        {line.side === 'debit' ? money(line.amount_cents, currency) : ''}
                      </td>
                      <td className="num line cr">
                        {line.side === 'credit'
                          ? money(Math.abs(line.amount_cents), currency)
                          : ''}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Total</strong>{' '}
                      {entry.balanced ? (
                        <Badge tone="green">balanced</Badge>
                      ) : (
                        <Badge tone="red">unbalanced</Badge>
                      )}
                    </td>
                    <td className="num">
                      <strong className="line dr">
                        {money(entry.total_debit_cents, currency)}
                      </strong>
                    </td>
                    <td className="num">
                      <strong className="line cr">
                        {money(entry.total_credit_cents, currency)}
                      </strong>
                    </td>
                  </tr>
                </tbody>
              </table>

              {entry.status === 'posted' && entry.entry_kind === 'standard' ? (
                <div className="inline" style={{ marginTop: 10 }}>
                  <input
                    placeholder="reason for reversal (required)"
                    value={reasons[entry.id] ?? ''}
                    onChange={(e) =>
                      setReasons((prev) => ({ ...prev, [entry.id]: e.target.value }))
                    }
                    style={{ maxWidth: 360 }}
                  />
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void reverse(entry.id)}
                  >
                    Reverse entry
                  </button>
                </div>
              ) : null}

              {entry.external_error ? (
                <div className="banner err" style={{ marginTop: 10, marginBottom: 0 }}>
                  External sync failed: {entry.external_error}
                </div>
              ) : null}
              {entry.external_ref ? (
                <div className="muted small" style={{ marginTop: 8 }}>
                  Confirmed by external platform · ref <span className="mono">{entry.external_ref}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
