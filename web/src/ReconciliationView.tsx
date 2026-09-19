/**
 * The reconciliation interface.
 *
 * Shows, per invoice, what the ledger says versus what the allocation and
 * credit ledger independently accounts for, and surfaces any divergence as
 * drift rather than smoothing it over. It is read-only by design: corrections
 * go through the proposal/approval flow, not from here.
 */

import { Fragment, useEffect, useState } from 'react';
import {
  api,
  money,
  timestamp,
  type AccountBalance,
  type ReconciliationRow,
  type ReconciliationSummary,
} from './api';
import { Badge, Empty, ErrorBanner, InvoiceStatus, Panel, ReminderStatus, Stat } from './ui';

interface Props {
  sellerId: string;
  currency: string;
}

export function ReconciliationView({ sellerId, currency }: Props) {
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [rows, setRows] = useState<ReconciliationRow[]>([]);
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [posture, setPosture] = useState<{ note: string; local_ledger_is_authoritative: boolean } | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .reconciliation(sellerId)
      .then((res) => {
        if (cancelled) return;
        setSummary(res.summary);
        setRows(res.rows);
        setAccounts(res.accounts);
        setPosture(res.posture);
      })
      .catch((err: Error) => {
        if (!cancelled) setError({ message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [sellerId]);

  if (error) return <ErrorBanner error={error} />;
  if (!summary) return <Empty>Loading reconciliation…</Empty>;

  return (
    <div>
      {posture ? (
        <div className={`banner ${posture.local_ledger_is_authoritative ? 'info' : 'warn'}`}>
          <strong>
            {posture.local_ledger_is_authoritative
              ? 'Local operational ledger is authoritative'
              : 'External accounting platform is authoritative'}
          </strong>
          {posture.note}
        </div>
      ) : null}

      <div className="grid-cards" style={{ marginBottom: 16 }}>
        <Stat
          label="Trial balance"
          value={money(summary.trial_balance_cents, currency)}
          tone={summary.trial_balanced ? 'ok' : 'bad'}
        />
        <Stat
          label="Reconciled invoices"
          value={`${summary.reconciled_count} / ${summary.invoice_count}`}
          tone={summary.drifted_count === 0 ? 'ok' : 'bad'}
        />
        <Stat
          label="Total outstanding"
          value={money(summary.total_outstanding_cents, currency)}
        />
        <Stat
          label="Allocated"
          value={money(summary.total_allocated_cents, currency)}
        />
        <Stat
          label="Unapplied cash"
          value={money(summary.total_unapplied_cash_cents, currency)}
          tone={summary.total_unapplied_cash_cents > 0 ? 'warn' : undefined}
        />
      </div>

      {summary.drift.length > 0 ? (
        <Panel
          title="Drift detected"
          hint="These are places where the stored balance disagrees with the underlying allocation and credit records. They are reported, never auto-corrected."
        >
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Description</th>
                <th className="num">Expected</th>
                <th className="num">Actual</th>
                <th className="num">Diff</th>
              </tr>
            </thead>
            <tbody>
              {summary.drift.map((d, i) => (
                <tr key={`${d.entity_id}-${i}`}>
                  <td>
                    <Badge tone="red">{d.kind}</Badge>
                  </td>
                  <td>{d.description}</td>
                  <td className="num">{money(d.expected_cents, currency)}</td>
                  <td className="num">{money(d.actual_cents, currency)}</td>
                  <td className="num">
                    <span className="line cr">{money(d.diff_cents, currency)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : (
        <div className="banner ok">
          <strong>No drift</strong>
          Every invoice balance agrees with its allocations, credit notes and adjustments, and the
          posted journal lines sum to zero.
        </div>
      )}

      <Panel title="Invoice reconciliation" hint={`As of ${timestamp(summary.as_of)}. Click a row to see its allocations and reminders.`}>
        <table>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Due</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Allocated</th>
              <th className="num">Balance</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.invoice.id}>
                <tr
                  onClick={() =>
                    setExpanded(expanded === row.invoice.id ? null : row.invoice.id)
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono">{row.invoice.number}</td>
                  <td>{row.invoice.customer_name}</td>
                  <td className="small muted">{row.invoice.due_date}</td>
                  <td>
                    <InvoiceStatus status={row.invoice.status} />
                  </td>
                  <td className="num">{money(row.invoice.total_cents, currency)}</td>
                  <td className="num">{money(row.allocated_cents, currency)}</td>
                  <td className="num">
                    <strong>{money(row.invoice.balance_cents, currency)}</strong>
                  </td>
                  <td>
                    {row.reconciled ? (
                      <Badge tone="green">ok</Badge>
                    ) : (
                      <Badge tone="red">drift {money(row.drift_cents, currency)}</Badge>
                    )}
                  </td>
                </tr>
                {expanded === row.invoice.id ? (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--bg)' }}>
                      <div className="split">
                        <div>
                          <div className="muted small" style={{ marginBottom: 6 }}>
                            Allocations
                          </div>
                          {row.allocations.length === 0 ? (
                            <Empty>No allocations.</Empty>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Payment</th>
                                  <th className="num">Amount</th>
                                  <th>Status</th>
                                  <th>Entry</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.allocations.map((a) => (
                                  <tr key={a.allocation_id}>
                                    <td className="mono small">
                                      {a.payment_reference ?? a.payment_id.slice(0, 10)}
                                    </td>
                                    <td className="num">{money(a.amount_cents, currency)}</td>
                                    <td>
                                      <Badge tone={a.status === 'active' ? 'green' : 'gray'}>
                                        {a.status}
                                      </Badge>
                                    </td>
                                    <td className="mono small">
                                      {a.journal_entry_id
                                        ? a.journal_entry_id.slice(0, 10)
                                        : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                        <div>
                          <div className="muted small" style={{ marginBottom: 6 }}>
                            Reminders
                          </div>
                          {row.reminders.length === 0 ? (
                            <Empty>No reminders scheduled.</Empty>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Kind</th>
                                  <th>For</th>
                                  <th>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.reminders.map((r) => (
                                  <tr key={r.id}>
                                    <td>{r.kind.replace('_', ' ')}</td>
                                    <td className="small muted">{r.scheduled_for}</td>
                                    <td>
                                      <ReminderStatus status={r.status} />
                                      {r.suppressed_reason ? (
                                        <div className="muted small">
                                          {r.suppressed_reason.replace('_', ' ')}
                                        </div>
                                      ) : null}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <Empty>No invoices for this seller.</Empty> : null}
      </Panel>

      <Panel
        title="Account balances"
        hint="Net movement per account from posted entries only. Reversed entries are excluded, which is why a reversal cancels its original."
      >
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th>Type</th>
              <th className="num">Debits</th>
              <th className="num">Credits</th>
              <th className="num">Net</th>
              <th className="num">Lines</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.account_id}>
                <td className="mono">{a.code}</td>
                <td>{a.name}</td>
                <td className="muted small">{a.type}</td>
                <td className="num line dr">
                  {a.debit_cents ? money(a.debit_cents, currency) : '—'}
                </td>
                <td className="num line cr">
                  {a.credit_cents ? money(a.credit_cents, currency) : '—'}
                </td>
                <td className="num">
                  <strong>{money(a.net_cents, currency)}</strong>
                </td>
                <td className="num muted">{a.line_count}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5}>
                <strong>Net across all accounts</strong>
              </td>
              <td className="num">
                <strong>
                  {money(
                    accounts.reduce((s, a) => s + a.net_cents, 0),
                    currency,
                  )}
                </strong>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
