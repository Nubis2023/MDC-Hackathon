/** Small presentational helpers shared across the views. */

import type { ReactNode } from 'react';

export function Badge({
  tone,
  children,
}: {
  tone: 'gray' | 'green' | 'amber' | 'red' | 'blue';
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const PROPOSAL_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  proposed: 'amber',
  approved: 'blue',
  posted: 'green',
  rejected: 'red',
  superseded: 'gray',
};

export function ProposalStatus({ status }: { status: string }) {
  return <Badge tone={PROPOSAL_TONE[status] ?? 'gray'}>{status}</Badge>;
}

const INVOICE_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  open: 'amber',
  partially_paid: 'blue',
  paid: 'green',
  void: 'gray',
};

export function InvoiceStatus({ status }: { status: string }) {
  return <Badge tone={INVOICE_TONE[status] ?? 'gray'}>{status.replace('_', ' ')}</Badge>;
}

const SYNC_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  not_applicable: 'gray',
  pending: 'amber',
  confirmed: 'green',
  failed: 'red',
};

export function SyncState({ state }: { state: string }) {
  const label =
    state === 'not_applicable' ? 'local only' : state.replace('_', ' ');
  return <Badge tone={SYNC_TONE[state] ?? 'gray'}>{label}</Badge>;
}

const REMINDER_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  scheduled: 'amber',
  sent: 'blue',
  suppressed: 'gray',
  skipped_settled: 'gray',
};

export function ReminderStatus({ status }: { status: string }) {
  return <Badge tone={REMINDER_TONE[status] ?? 'gray'}>{status}</Badge>;
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'bad' | 'warn';
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
  actions,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="inline" style={{ marginBottom: 2 }}>
        <h2>{title}</h2>
        {actions ? <div className="right inline">{actions}</div> : null}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({
  error,
  onDismiss,
}: {
  error: { message: string; code?: string } | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="banner err">
      <div className="inline">
        <strong style={{ margin: 0 }}>
          {error.code ? `${error.code}: ` : ''}
          {error.message}
        </strong>
        {onDismiss ? (
          <button className="ghost right" onClick={onDismiss}>
            dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function OkBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner ok">
      <strong>Done</strong>
      {children}
    </div>
  );
}
