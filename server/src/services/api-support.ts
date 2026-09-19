/**
 * Small helpers the API layer needs that are not part of the ledger domain:
 * describing the tool registry to a client, and summarising proposals for
 * list views without shipping every preview JSON blob.
 */

import type { Db } from '../db';
import { TOOL_DEFINITIONS, type ToolDefinition } from './agent-tools';

export { callTool } from './agent-tools';

export function describeTools(): Array<
  ToolDefinition & { approval_note: string }
> {
  return TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    approval_note: tool.requires_human
      ? 'Requires a human seller user. Agents cannot call this tool.'
      : tool.mutates_ledger
        ? 'Changes ledger state. Posting requires prior approval or a matching auto-post rule.'
        : 'Read-only. Safe to call before proposing.',
  }));
}

export interface ProposalSummary {
  id: string;
  proposal_kind: string;
  status: string;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approval_basis: string | null;
  posted_entry_id: string | null;
  summary: string;
  total_debit_cents: number;
  balanced: boolean;
}

/**
 * Compact proposal rows for the list view, including a one-line human
 * summary so the UI does not have to render raw JSON to be useful.
 */
export function listProposalSummaries(
  db: Db,
  sellerId: string,
): ProposalSummary[] {
  const rows = db
    .prepare(
      `SELECT id, proposal_kind, status, proposed_by, proposed_at, approved_by,
              approval_basis, posted_entry_id, preview_json
         FROM ledger_proposals
        WHERE seller_id = ?
        ORDER BY proposed_at DESC, rowid DESC
        LIMIT 200`,
    )
    .all(sellerId) as Array<{
    id: string;
    proposal_kind: string;
    status: string;
    proposed_by: string;
    proposed_at: string;
    approved_by: string | null;
    approval_basis: string | null;
    posted_entry_id: string | null;
    preview_json: string;
  }>;

  return rows.map((row) => {
    const preview = JSON.parse(row.preview_json) as {
      memo: string;
      total_debit_cents: number;
      balanced: boolean;
      affected_invoices: Array<{ number: string; applied_cents: number }>;
    };
    const invoiceNote = preview.affected_invoices.length
      ? ` → invoices ${preview.affected_invoices.map((i) => i.number).join(', ')}`
      : '';
    return {
      id: row.id,
      proposal_kind: row.proposal_kind,
      status: row.status,
      proposed_by: row.proposed_by,
      proposed_at: row.proposed_at,
      approved_by: row.approved_by,
      approval_basis: row.approval_basis,
      posted_entry_id: row.posted_entry_id,
      summary: `${preview.memo}${invoiceNote}`,
      total_debit_cents: preview.total_debit_cents,
      balanced: preview.balanced,
    };
  });
}
