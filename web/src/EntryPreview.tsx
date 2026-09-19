/**
 * Renders the proposed journal entry as a debit/credit table.
 *
 * This is the artefact the requirement is about: before anything is posted,
 * the approver sees the exact debits and credits, the affected invoices with
 * their balance changes, and the source records the entry is based on.
 */

import type { LedgerPreview } from './api';
import { money, shortId } from './api';
import { Badge } from './ui';

export function EntryPreview({ preview }: { preview: LedgerPreview }) {
  const debits = preview.lines.filter((l) => l.side === 'debit');
  const credits = preview.lines.filter((l) => l.side === 'credit');

  return (
    <div className="stack">
      <div className="inline">
        <strong>{preview.memo}</strong>
        <span className="right inline">
          {preview.balanced ? (
            <Badge tone="green">balanced</Badge>
          ) : (
            <Badge tone="red">UNBALANCED — will be refused</Badge>
          )}
          <span className="muted small">{preview.entry_date}</span>
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: '46%' }}>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {[...debits, ...credits].map((line, i) => (
            <tr key={`${line.account_id}-${i}`}>
              <td>
                <span className="mono">{line.account_code}</span> {line.account_name}
                {line.memo ? (
                  <div className="muted small">{line.memo}</div>
                ) : null}
              </td>
              <td className="num">
                {line.side === 'debit' ? (
                  <span className="line dr">
                    {money(line.amount_cents, preview.currency)}
                  </span>
                ) : (
                  ''
                )}
              </td>
              <td className="num">
                {line.side === 'credit' ? (
                  <span className="line cr">
                    {money(line.amount_cents, preview.currency)}
                  </span>
                ) : (
                  ''
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong className="line dr">
                {money(preview.total_debit_cents, preview.currency)}
              </strong>
            </td>
            <td className="num">
              <strong className="line cr">
                {money(preview.total_credit_cents, preview.currency)}
              </strong>
            </td>
          </tr>
        </tbody>
      </table>

      {preview.affected_invoices.length > 0 ? (
        <div>
          <div className="section-label muted small" style={{ marginBottom: 4 }}>
            Affected invoices
          </div>
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th className="num">Balance before</th>
                <th className="num">Applied</th>
                <th className="num">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {preview.affected_invoices.map((inv) => (
                <tr key={inv.invoice_id}>
                  <td className="mono">{inv.number}</td>
                  <td className="num">{money(inv.balance_before_cents, preview.currency)}</td>
                  <td className="num">
                    {inv.applied_cents >= 0 ? (
                      <span className="line dr">
                        −{money(inv.applied_cents, preview.currency)}
                      </span>
                    ) : (
                      <span className="line cr">
                        +{money(-inv.applied_cents, preview.currency)}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <strong>{money(inv.balance_after_cents, preview.currency)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.supporting_records.length > 0 ? (
        <div>
          <div className="muted small" style={{ marginBottom: 4 }}>
            Supporting source records
          </div>
          <table>
            <tbody>
              {preview.supporting_records.map((rec, i) => (
                <tr key={`${rec.entity_id}-${i}`}>
                  <td style={{ width: 110 }}>
                    <Badge tone="gray">{rec.entity_type}</Badge>
                  </td>
                  <td>{rec.description}</td>
                  <td className="mono muted small right">{shortId(rec.entity_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
