/**
 * Proposal queue: the record → allocate → credit → fee → refund → adjustment
 * workflow, with the approval gate made explicit.
 *
 * The controls are visible here on purpose. An approve button that the backend
 * would reject is disabled and labelled with why, so the UI never implies a
 * capability the server does not grant.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  money,
  parseMoney,
  timestamp,
  type Invoice,
  type LedgerPreview,
  type Payment,
  type Proposal,
  type ProposalSummary,
} from './api';
import { EntryPreview } from './EntryPreview';
import { Badge, Empty, ErrorBanner, OkBanner, Panel, ProposalStatus } from './ui';

interface Props {
  sellerId: string;
  actorId: string;
  actorKind: 'human' | 'agent';
  currency: string;
  /** Lets the parent refresh dependent views after a posting. */
  onLedgerChange: () => void;
}

type OperationKind =
  | 'record_payment'
  | 'allocate_payment'
  | 'apply_credit_note'
  | 'record_fee'
  | 'record_refund';

export function ProposalsView({
  sellerId,
  actorId,
  actorKind,
  currency,
  onLedgerChange,
}: Props) {
  const [summaries, setSummaries] = useState<ProposalSummary[]>([]);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state
  const [kind, setKind] = useState<OperationKind>('record_payment');
  const [amount, setAmount] = useState('1250.00');
  const [reference, setReference] = useState('WIRE-10001');
  const [payerName, setPayerName] = useState('Harbor Logistics');
  const [paymentId, setPaymentId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [description, setDescription] = useState('Card processing fee');
  const [reason, setReason] = useState('Damaged goods');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [preview, setPreview] = useState<LedgerPreview | null>(null);
  const [rejectReason, setRejectReason] = useState('Not authorised');

  const refresh = useCallback(async () => {
    try {
      const [p, inv, pay] = await Promise.all([
        api.proposals(sellerId),
        api.invoices(sellerId),
        api.payments(sellerId),
      ]);
      setSummaries(p.summaries);
      setInvoices(inv.invoices);
      setPayments(pay.payments);
      setError(null);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buildOperation = (): Record<string, unknown> => {
    const cents = parseMoney(amount);
    switch (kind) {
      case 'record_payment':
        return {
          kind,
          amount_cents: cents,
          received_at: new Date().toISOString(),
          reference: reference || null,
          payer_name: payerName || null,
        };
      case 'allocate_payment':
        return {
          kind,
          payment_id: paymentId,
          invoice_id: invoiceId,
          amount_cents: cents,
        };
      case 'apply_credit_note':
        return { kind, invoice_id: invoiceId, amount_cents: cents, reason: reason || null };
      case 'record_fee':
        return {
          kind,
          payment_id: paymentId || null,
          amount_cents: cents,
          description,
        };
      case 'record_refund':
        return {
          kind,
          payment_id: paymentId,
          invoice_id: invoiceId || null,
          amount_cents: cents,
          reason: reason || null,
        };
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
    } catch (err) {
      const e = err as { message: string; code?: string; detail?: unknown };
      setError({ message: e.message, code: e.code });
    } finally {
      setBusy(false);
    }
  };

  const doPreview = () =>
    run(async () => {
      const res = await api.preview(sellerId, buildOperation());
      setPreview(res.preview);
    });

  const doPropose = () =>
    run(async () => {
      const res = await api.propose(
        sellerId,
        buildOperation(),
        idempotencyKey || undefined,
      );
      setPreview(res.proposal.preview);
      setSelected(res.proposal);
      setOk(
        `Proposal ${res.proposal.id.slice(0, 14)} created and awaiting approval. ` +
          'Nothing has been posted to the ledger yet.',
      );
      await refresh();
    });

  const doApprove = (id: string) =>
    run(async () => {
      await api.approve(id, 'Approved in the reconciliation interface');
      setOk('Proposal approved. It can now be posted.');
      await refresh();
      if (selected?.id === id) setSelected(await api.proposals(sellerId).then((p) => p.proposals.find((x) => x.id === id) ?? null));
    });

  const doReject = (id: string) =>
    run(async () => {
      await api.reject(id, rejectReason);
      setOk('Proposal rejected. Nothing was posted.');
      await refresh();
      if (selected?.id === id) setSelected(null);
    });

  const doPost = (id: string) =>
    run(async () => {
      const res = await api.post(id, idempotencyKey || undefined);
      const result = res.result as {
        entry_no: number;
        replayed?: boolean;
        external_sync_state?: string;
        reminders?: Array<{ suppressed: string[] }>;
      };
      const suppressed = (result.reminders ?? []).reduce(
        (n, r) => n + r.suppressed.length,
        0,
      );
      setOk(
        `Posted as journal entry #${result.entry_no}` +
          (result.replayed ? ' (replayed an existing posting — no duplicate was created)' : '') +
          (suppressed > 0
            ? ` · ${suppressed} reminder(s) suppressed because the invoice is now settled`
            : '') +
          (result.external_sync_state === 'pending'
            ? ' · awaiting confirmation from the external accounting platform'
            : ''),
      );
      await refresh();
      onLedgerChange();
    });

  const openProposal = (id: string) =>
    run(async () => {
      const all = await api.proposals(sellerId);
      const found = all.proposals.find((p) => p.id === id) ?? null;
      setSelected(found);
      setPreview(found?.preview ?? null);
    });

  const approveBlocked =
    actorKind === 'agent'
      ? 'Agents cannot approve — approval must come from a seller user'
      : null;

  return (
    <div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {ok ? <OkBanner>{ok}</OkBanner> : null}

      <Panel
        title="Create a ledger update"
        hint="Preview shows the proposed debits and credits, the affected invoices and their balance changes, and the source records — before anything is written."
      >
        <div className="row">
          <div className="col">
            <label className="small muted">Operation</label>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as OperationKind);
                setPreview(null);
              }}
            >
              <option value="record_payment">Record a confirmed payment</option>
              <option value="allocate_payment">Allocate a payment to an invoice</option>
              <option value="apply_credit_note">Apply a credit note</option>
              <option value="record_fee">Record a fee</option>
              <option value="record_refund">Record a refund</option>
            </select>
          </div>

          <div className="col">
            <label className="small muted">Amount (USD)</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1250.00" />
          </div>

          {(kind === 'allocate_payment' || kind === 'record_fee' || kind === 'record_refund') && (
            <div className="col">
              <label className="small muted">Payment</label>
              <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
                <option value="">Select a payment…</option>
                {payments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference ?? p.id.slice(0, 12)} · {money(p.amount_cents, currency)} ·{' '}
                    {money(p.unallocated_cents, currency)} free
                  </option>
                ))}
              </select>
            </div>
          )}

          {(kind === 'allocate_payment' || kind === 'apply_credit_note' || kind === 'record_refund') && (
            <div className="col">
              <label className="small muted">Invoice</label>
              <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                <option value="">Select an invoice…</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} · {i.customer_name} · {money(i.balance_cents, currency)} due
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          {kind === 'record_payment' && (
            <>
              <div className="col">
                <label className="small muted">Reference</label>
                <input value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
              <div className="col">
                <label className="small muted">Payer</label>
                <input value={payerName} onChange={(e) => setPayerName(e.target.value)} />
              </div>
            </>
          )}
          {kind === 'record_fee' && (
            <div className="col">
              <label className="small muted">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          )}
          {(kind === 'apply_credit_note' || kind === 'record_refund') && (
            <div className="col">
              <label className="small muted">Reason</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <div className="col">
            <label className="small muted">Idempotency key (optional retry key)</label>
            <input
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              placeholder="reuse on retry to avoid a duplicate"
            />
          </div>
        </div>

        <div className="inline" style={{ marginTop: 14 }}>
          <button onClick={doPreview} disabled={busy}>
            Preview
          </button>
          <button className="primary" onClick={doPropose} disabled={busy}>
            Propose
          </button>
        </div>
      </Panel>

      {preview ? (
        <Panel title="Proposed journal entry">
          <EntryPreview preview={preview} />
        </Panel>
      ) : null}

      <Panel
        title="Proposal queue"
        hint="Approval is required before posting unless an enabled exact-match auto-post rule covers the operation."
        actions={<button className="ghost" onClick={() => void refresh()}>refresh</button>}
      >
        <table>
          <thead>
            <tr>
              <th>Summary</th>
              <th>Kind</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th>Proposed by</th>
              <th>Approved by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => {
              const canApprove =
                s.status === 'proposed' && s.proposed_by !== actorId && actorKind === 'human';
              const canPost = s.status === 'approved';
              return (
                <tr key={s.id}>
                  <td>
                    <button className="ghost" onClick={() => void openProposal(s.id)} style={{ padding: 0, border: 'none', color: 'var(--accent)' }}>
                      {s.summary}
                    </button>
                  </td>
                  <td className="muted small">{s.proposal_kind.replace('_', ' ')}</td>
                  <td>
                    <ProposalStatus status={s.status} />
                    {s.approval_basis === 'auto_rule' ? (
                      <div>
                        <Badge tone="blue">auto rule</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{money(s.total_debit_cents, currency)}</td>
                  <td className="mono small">{s.proposed_by}</td>
                  <td className="mono small">{s.approved_by ?? '—'}</td>
                  <td>
                    <div className="inline" style={{ justifyContent: 'flex-end' }}>
                      {s.status === 'proposed' ? (
                        <>
                          <button
                            className="primary"
                            disabled={busy || !canApprove}
                            title={approveBlocked ?? undefined}
                            onClick={() => void doApprove(s.id)}
                          >
                            Approve
                          </button>
                          <button className="danger" disabled={busy} onClick={() => void doReject(s.id)}>
                            Reject
                          </button>
                        </>
                      ) : null}
                      {canPost ? (
                        <button className="primary" disabled={busy} onClick={() => void doPost(s.id)}>
                          Post
                        </button>
                      ) : null}
                      {s.posted_entry_id ? (
                        <span className="muted small mono">{s.posted_entry_id.slice(0, 10)}</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {summaries.length === 0 ? <Empty>No proposals yet.</Empty> : null}

        {actorKind === 'agent' ? (
          <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Acting as an agent</strong>
            {approveBlocked}. You can still propose and post (once a human has approved) — the
            backend enforces this, not the interface.
          </div>
        ) : null}
      </Panel>

      {selected ? (
        <Panel
          title={`Proposal ${selected.id.slice(0, 14)}`}
          hint={`${selected.proposal_kind} · proposed by ${selected.proposed_by} at ${timestamp(selected.proposed_at)}`}
          actions={
            <button className="ghost" onClick={() => setSelected(null)}>
              close
            </button>
          }
        >
          <div className="inline" style={{ marginBottom: 10 }}>
            <ProposalStatus status={selected.status} />
            {selected.approval_basis ? (
              <Badge tone="blue">approved via {selected.approval_basis.replace('_', ' ')}</Badge>
            ) : null}
          </div>
          <EntryPreview preview={selected.preview} />

          {selected.status === 'proposed' ? (
            <div className="inline" style={{ marginTop: 14 }}>
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="rejection reason"
                style={{ maxWidth: 320 }}
              />
              <button
                className="primary"
                disabled={busy || actorKind === 'agent' || selected.proposed_by === actorId}
                onClick={() => void doApprove(selected.id)}
              >
                Approve
              </button>
              <button className="danger" disabled={busy} onClick={() => void doReject(selected.id)}>
                Reject
              </button>
            </div>
          ) : null}
          {selected.status === 'approved' ? (
            <div className="inline" style={{ marginTop: 14 }}>
              <button className="primary" disabled={busy} onClick={() => void doPost(selected.id)}>
                Post to ledger
              </button>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
