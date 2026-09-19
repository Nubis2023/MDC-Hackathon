/**
 * Agent tool console.
 *
 * A direct view of the five tools, so the controls can be demonstrated rather
 * than taken on trust. Calling approve_ledger_update as the agent shows the
 * backend refusing it; the same call as a human succeeds. Nothing here is
 * special-cased for the agent — it goes through the same service layer the UI
 * uses.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type Actor, type ToolDefinition } from './api';
import { Badge, Empty, ErrorBanner, Panel } from './ui';

interface Props {
  sellerId: string;
  actor: Actor;
  revision: number;
}

export function AgentConsoleView({ sellerId, actor, revision }: Props) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [output, setOutput] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);

  // form state
  const [operationJson, setOperationJson] = useState(
    JSON.stringify(
      {
        kind: 'record_payment',
        amount_cents: 50000,
        received_at: new Date().toISOString(),
        reference: 'AGENT-DEMO-1',
        payer_name: 'Vantage Studios',
      },
      null,
      2,
    ),
  );
  const [proposalId, setProposalId] = useState('');
  const [entryId, setEntryId] = useState('');
  const [reason, setReason] = useState('Recorded against the wrong invoice');

  const load = useCallback(async () => {
    try {
      const res = await api.tools();
      setTools(res.tools);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const call = async (toolName: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setOutput('');
    try {
      const res = await api.callTool(toolName, args);
      setLastOk(res.ok);
      setOutput(JSON.stringify(res, null, 2));
      // Surface a created proposal id so the next step is one click away.
      const result = res.result as { proposal_id?: string; entry_id?: string } | undefined;
      if (result?.proposal_id) setProposalId(result.proposal_id);
      if (result?.entry_id) setEntryId(result.entry_id);
    } catch (err) {
      const e = err as { message: string; code?: string };
      setLastOk(false);
      setOutput(JSON.stringify({ ok: false, error: e }, null, 2));
    } finally {
      setBusy(false);
    }
  };

  const parseOperation = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(operationJson) as Record<string, unknown>;
      return { ...parsed, seller_id: sellerId };
    } catch {
      setError({ message: 'The operation JSON is not valid JSON.' });
      return null;
    }
  };

  return (
    <div>
      <ErrorBanner error={error} />

      <div className={`banner ${actor.kind === 'agent' ? 'warn' : 'info'}`}>
        <strong>
          Acting as {actor.name} ({actor.kind})
        </strong>
        {actor.kind === 'agent'
          ? 'Agents can propose, preview, post and reverse — but approval requires a human seller user, and a proposal can never be approved by the actor that raised it. Both rules are enforced in the backend, not here.'
          : 'As a human with approval rights you can approve proposals — except ones you raised yourself.'}
      </div>

      <Panel
        title="Tool registry"
        hint="What the agent is told it can do. The approval rules are enforced in the service layer regardless of what any caller attempts."
      >
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Mutates ledger</th>
              <th>Requires human</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td>{t.mutates_ledger ? <Badge tone="amber">yes</Badge> : <Badge tone="gray">no</Badge>}</td>
                <td>{t.requires_human ? <Badge tone="red">yes</Badge> : <Badge tone="gray">no</Badge>}</td>
                <td className="small muted">{t.approval_note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tools.length === 0 ? <Empty>No tools registered.</Empty> : null}
      </Panel>

      <Panel
        title="Call a tool"
        hint="The seller id is injected from the selected seller, so every call is seller-scoped."
      >
        <div className="stack">
          <div>
            <label className="small muted">Operation (for preview / propose)</label>
            <textarea
              rows={10}
              value={operationJson}
              onChange={(e) => setOperationJson(e.target.value)}
              className="pre"
              style={{ width: '100%' }}
            />
          </div>

          <div className="inline">
            <button
              disabled={busy}
              onClick={() => {
                const op = parseOperation();
                if (op) void call('preview_ledger_update', { operation: op });
              }}
            >
              preview_ledger_update
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                const op = parseOperation();
                if (op) void call('propose_ledger_update', { operation: op });
              }}
            >
              propose_ledger_update
            </button>
          </div>

          <div className="row">
            <div className="col">
              <label className="small muted">Proposal id</label>
              <input value={proposalId} onChange={(e) => setProposalId(e.target.value)} />
            </div>
            <div className="col">
              <label className="small muted">Entry id (for reversal)</label>
              <input value={entryId} onChange={(e) => setEntryId(e.target.value)} />
            </div>
            <div className="col">
              <label className="small muted">Reversal reason</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>

          <div className="inline">
            <button
              disabled={busy || !proposalId}
              onClick={() => void call('approve_ledger_update', { proposal_id: proposalId })}
            >
              approve_ledger_update
            </button>
            <button
              disabled={busy || !proposalId}
              onClick={() => void call('post_ledger_update', { proposal_id: proposalId })}
            >
              post_ledger_update
            </button>
            <button
              disabled={busy || !entryId}
              onClick={() => void call('reverse_ledger_entry', { entry_id: entryId, reason })}
            >
              reverse_ledger_entry
            </button>
          </div>
        </div>
      </Panel>

      {output ? (
        <Panel
          title="Tool result"
          actions={
            lastOk === null ? undefined : lastOk ? (
              <Badge tone="green">ok</Badge>
            ) : (
              <Badge tone="red">refused</Badge>
            )
          }
        >
          <pre className="pre">{output}</pre>
        </Panel>
      ) : null}
    </div>
  );
}
