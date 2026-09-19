/**
 * Application shell.
 *
 * Actor and seller switching are the two controls that make the backend's
 * authorisation model visible: changing the actor changes what the interface
 * can do, because the server enforces the rules rather than the UI hiding
 * buttons.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  setActor,
  type Actor,
  type Bootstrap,
  type SellerInfo,
} from './api';
import { ReconciliationView } from './ReconciliationView';
import { ProposalsView } from './ProposalsView';
import { JournalView } from './JournalView';
import { RemindersView, AuditView } from './ActivityViews';
import { SyncView, AdjustmentsView } from './SyncAndAdjustmentsViews';
import { AgentConsoleView } from './AgentConsoleView';
import { Badge, ErrorBanner } from './ui';

type View =
  | 'reconciliation'
  | 'proposals'
  | 'journal'
  | 'reminders'
  | 'adjustments'
  | 'sync'
  | 'audit'
  | 'agent';

const NAV: Array<{ id: View; label: string }> = [
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'proposals', label: 'Ledger updates' },
  { id: 'journal', label: 'Journal' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'adjustments', label: 'Adjustments' },
  { id: 'sync', label: 'External sync' },
  { id: 'audit', label: 'Audit' },
  { id: 'agent', label: 'Agent tools' },
];

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [sellerId, setSellerId] = useState<string>('');
  const [view, setView] = useState<View>('reconciliation');
  const [error, setError] = useState<{ message: string } | null>(null);
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api.bootstrap();
      setBoot(res);
      setError(null);
      if (!sellerId && res.sellers.length > 0) {
        setSellerId(res.sellers[0]!.id);
      }
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [sellerId]);

  useEffect(() => {
    void load();
    // Only on mount; seller selection is preserved across actor switches so
    // the access-denied path is observable rather than silently reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchActor = async (id: string) => {
    setActor(id);
    // Force every view to refetch as the new actor.
    setRevision((r) => r + 1);
    setView('reconciliation');
    await load();
  };

  const onLedgerChange = () => setRevision((r) => r + 1);

  if (error && !boot) {
    return (
      <div className="content">
        <ErrorBanner error={error} />
        <p className="muted">
          Is the API running? Start it with <code>npm run dev</code> in <code>server/</code>.
        </p>
      </div>
    );
  }

  if (!boot) return <div className="content">Loading…</div>;

  const seller: SellerInfo | undefined = boot.sellers.find((s) => s.id === sellerId);
  const actor: Actor = boot.actor;
  const currency = seller?.currency ?? 'USD';

  // An actor with no membership of the selected seller gets an explicit
  // refusal from the API; show that rather than an empty screen.
  const selectedSellerAccessible = Boolean(seller);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Seller Ledger</h1>
        <div className="sub">Seller-scoped reconciliation &amp; write service</div>

        <div className="section-label">Views</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-btn${view === item.id ? ' active' : ''}`}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}

        <div className="section-label">Reference</div>
        <div className="small muted" style={{ padding: '0 9px' }}>
          Every record is seller-scoped. Postings require approval; posted entries are immutable
          and corrected by reversal.
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <label className="small muted">Seller</label>
            <select
              value={sellerId}
              onChange={(e) => {
                setSellerId(e.target.value);
                setRevision((r) => r + 1);
              }}
              style={{ minWidth: 220 }}
            >
              {boot.sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.role})
                </option>
              ))}
              {boot.sellers.length === 0 ? <option value="">no sellers</option> : null}
            </select>
          </div>

          <div>
            <label className="small muted">Acting as</label>
            <select
              value={actor.id}
              onChange={(e) => void switchActor(e.target.value)}
              style={{ minWidth: 220 }}
            >
              {boot.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.kind}
                </option>
              ))}
            </select>
          </div>

          <div className="spacer" />

          <div className="inline">
            <Badge tone={actor.kind === 'agent' ? 'amber' : 'blue'}>{actor.kind}</Badge>
            {seller?.role ? <Badge tone="gray">role: {seller.role}</Badge> : null}
            {seller ? (
              <Badge
                tone={
                  seller.authoritative_system === 'local' ? 'blue' : 'amber'
                }
              >
                {seller.authoritative_system === 'local'
                  ? 'local ledger authoritative'
                  : 'external platform authoritative'}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="content">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />

          {!selectedSellerAccessible ? (
            <div className="banner err">
              <strong>No access to this seller</strong>
              {actor.name} has no membership of <code>{sellerId}</code>. The API refuses every
              request for this seller — switch the acting user, or switch to a seller this actor
              belongs to.
            </div>
          ) : (
            <>
              {view === 'reconciliation' ? (
                <ReconciliationView sellerId={sellerId} currency={currency} key={`rec-${revision}`} />
              ) : null}

              {view === 'proposals' ? (
                <ProposalsView
                  sellerId={sellerId}
                  actorId={actor.id}
                  actorKind={actor.kind}
                  currency={currency}
                  onLedgerChange={onLedgerChange}
                />
              ) : null}

              {view === 'journal' ? (
                <JournalView
                  sellerId={sellerId}
                  currency={currency}
                  onLedgerChange={onLedgerChange}
                  key={`jr-${revision}`}
                />
              ) : null}

              {view === 'reminders' ? (
                <RemindersView sellerId={sellerId} revision={revision} key={`rm-${revision}`} />
              ) : null}

              {view === 'adjustments' ? (
                <AdjustmentsView
                  sellerId={sellerId}
                  currency={currency}
                  revision={revision}
                  key={`adj-${revision}`}
                />
              ) : null}

              {view === 'sync' ? (
                <SyncView sellerId={sellerId} revision={revision} key={`sy-${revision}`} />
              ) : null}

              {view === 'audit' ? (
                <AuditView sellerId={sellerId} revision={revision} key={`au-${revision}`} />
              ) : null}

              {view === 'agent' ? (
                <AgentConsoleView
                  sellerId={sellerId}
                  actor={actor}
                  revision={revision}
                  key={`ag-${revision}-${actor.id}`}
                />
              ) : null}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
