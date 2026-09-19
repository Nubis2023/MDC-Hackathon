/**
 * Approval controls and auto-post rules.
 *
 * Covers the staged requirement: seller approval is required initially, and
 * automatic posting is only permitted later for explicitly authorised,
 * exact-match rules. Also covers the hard rule that the agent cannot approve
 * its own proposal.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
} from '../src/services/ledger';
import {
  createAutoPostRule,
  findMatchingAutoPostRule,
  setAutoPostRuleEnabled,
} from '../src/services/auto-post';
import { callTool } from '../src/services/agent-tools';
import {
  AGENT,
  APPROVER,
  BOOKKEEPER,
  OWNER,
  makeTestDb,
} from './helpers';

describe('approval controls', async () => {
  it('requires approval before a proposal can be posted', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    expect(proposal.status).toBe('proposed');
    await expect(postLedgerUpdate(db, APPROVER, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('posts after a different human approves', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'looks right' });

    const result = await postLedgerUpdate(db, APPROVER, proposal.id);
    expect(result.replayed).toBe(false);
    expect(result.entry_id).toBeTruthy();
  });

  it('forbids an agent from approving its own proposal', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    try {
      await approveLedgerUpdate(db, AGENT, proposal.id);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as LedgerError).code).toBe('self_approval');
    }
  });

  it('forbids a human from approving their own proposal', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, OWNER, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    await expect(approveLedgerUpdate(db, OWNER, proposal.id)).rejects.toThrowError(
      /cannot be approved by the actor that raised it/,
    );
  });

  it('rejects an agent calling the approve tool', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });

    const result = await callTool(db, AGENT, 'approve_ledger_update', {
      proposal_id: proposal.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('self_approval');
    expect(result.error?.message).toMatch(/agent may not approve|requires a human/);
  });

  it('lets an agent propose and post once a human has approved', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposed = await callTool(db, AGENT, 'propose_ledger_update', {
      operation: {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 2500,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'AGENT-FLOW',
      },
    });
    expect(proposed.ok).toBe(true);
    const proposalId = (proposed.result as { proposal_id: string }).proposal_id;

    await callTool(db, APPROVER, 'approve_ledger_update', { proposal_id: proposalId });

    const posted = await callTool(db, AGENT, 'post_ledger_update', {
      proposal_id: proposalId,
    });
    expect(posted.ok).toBe(true);
    const result = posted.result as { entry_no: number; external_sync_state: string };
    expect(result.entry_no).toBeGreaterThan(0);
    expect(result.external_sync_state).toBe('not_applicable');
  });

  it('reports an is_balanced preview to the approver', async () => {
    const { db, sellerId } = await makeTestDb();
    const result = await callTool(db, AGENT, 'preview_ledger_update', {
      operation: {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 4200,
        received_at: '2026-09-01T12:00:00.000Z',
        reference: 'PREVIEW-1',
      },
    });
    expect(result.ok).toBe(true);
    const preview = (result.result as { preview: Record<string, unknown> }).preview;
    expect(preview.balanced).toBe(true);
    expect(preview.total_debit_cents).toBe(4200);
    expect(preview.total_credit_cents).toBe(4200);
  });

  it('previews without persisting anything', async () => {
    const { db, sellerId } = await makeTestDb();
    await callTool(db, AGENT, 'preview_ledger_update', {
      operation: {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 4200,
        received_at: '2026-09-01T12:00:00.000Z',
      },
    });
    const proposals = await db.get(`SELECT COUNT(*) AS n FROM ledger_proposals WHERE seller_id = ?`, [sellerId]) as { n: number };
    expect(proposals.n).toBe(0);
  });
});

describe('auto-post rules', async () => {
  it('does not auto-post when no rule exists', async () => {
    const { db, sellerId } = await makeTestDb();
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await expect(postLedgerUpdate(db, AGENT, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('does not auto-post from a disabled rule', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_disabled',
      seller_id: sellerId,
      name: 'Disabled rule',
      proposal_kind: 'record_payment',
      match: { amount_cents: 1000 },
      enabled: false,
      created_by: OWNER.id,
    });

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await expect(postLedgerUpdate(db, AGENT, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('auto-posts from an enabled exact-match rule', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_exact',
      seller_id: sellerId,
      name: 'Exact fee match',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee', amount_cents: 2700 },
      enabled: true,
      created_by: OWNER.id,
    });

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 2700,
      description: 'Card processing fee',
    });

    const result = await postLedgerUpdate(db, AGENT, proposal.id);
    expect(result.entry_id).toBeTruthy();
    expect(result.proposal.approval_basis).toBe('auto_rule');
    expect(result.proposal.auto_rule_id).toBe('rule_exact');
  });

  it('refuses to auto-post when a field does not match exactly', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_narrow',
      seller_id: sellerId,
      name: 'Only 2700',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee', amount_cents: 2700 },
      enabled: true,
      created_by: OWNER.id,
    });

    // Same description, different amount: not an exact match.
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 5000,
      description: 'Card processing fee',
    });
    await expect(postLedgerUpdate(db, AGENT, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('respects the rule amount ceiling', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_capped',
      seller_id: sellerId,
      name: 'Fees under 50 dollars',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee' },
      max_amount_cents: 5000,
      enabled: true,
      created_by: OWNER.id,
    });

    // Within the cap: auto-posts.
    const small = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 4000,
      description: 'Card processing fee',
    });
    expect((await postLedgerUpdate(db, AGENT, small.id)).proposal.approval_basis).toBe(
      'auto_rule',
    );

    // Over the cap: falls back to manual approval.
    const large = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 9000,
      description: 'Card processing fee',
    });
    await expect(postLedgerUpdate(db, AGENT, large.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('does not match an empty rule, which would authorise everything', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_empty',
      seller_id: sellerId,
      name: 'Catch-all that must not work',
      proposal_kind: 'record_payment',
      match: {},
      enabled: true,
      created_by: OWNER.id,
    });

    const match = await findMatchingAutoPostRule(db, {
      seller_id: sellerId,
      proposal_kind: 'record_payment',
      fields: { amount_cents: 1000 },
      amount_cents: 1000,
    });
    expect(match).toBeNull();
  });

  it('does not let a rule for one kind authorise another', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_kind',
      seller_id: sellerId,
      name: 'Fees only',
      proposal_kind: 'record_fee',
      match: { amount_cents: 1000 },
      enabled: true,
      created_by: OWNER.id,
    });

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 1000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await expect(postLedgerUpdate(db, AGENT, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('stops auto-posting once the rule is disabled again', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_toggle',
      seller_id: sellerId,
      name: 'Toggle me',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee' },
      enabled: true,
      created_by: OWNER.id,
    });

    await setAutoPostRuleEnabled(db, sellerId, 'rule_toggle', false);

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 2700,
      description: 'Card processing fee',
    });
    await expect(postLedgerUpdate(db, AGENT, proposal.id)).rejects.toThrowError(
      /requires seller approval/,
    );
  });

  it('records the match evidence on the proposal for later explanation', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_evidence',
      seller_id: sellerId,
      name: 'Evidence rule',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee' },
      enabled: true,
      created_by: OWNER.id,
    });

    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 2700,
      description: 'Card processing fee',
    });
    await postLedgerUpdate(db, AGENT, proposal.id);

    const row = await db.get(`SELECT auto_rule_match_json FROM ledger_proposals WHERE id = ?`, [proposal.id]) as { auto_rule_match_json: string };
    const evidence = JSON.parse(row.auto_rule_match_json) as {
      match_mode: string;
      matched_fields: Record<string, unknown>;
    };
    expect(evidence.match_mode).toBe('exact');
    expect(evidence.matched_fields.description).toBe('Card processing fee');
  });

  it('keeps the ledger balanced across an auto-posted entry', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_bal',
      seller_id: sellerId,
      name: 'Balanced',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee' },
      enabled: true,
      created_by: OWNER.id,
    });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 2700,
      description: 'Card processing fee',
    });
    await postLedgerUpdate(db, AGENT, proposal.id);

    const total = await db.get(
        `SELECT COALESCE(SUM(l.amount_cents), 0) AS total
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.seller_id = ? AND e.status = 'posted'`, [sellerId]) as { total: number };
    expect(total.total).toBe(0);
  });

  it('attributes an auto-posted approval to the rule, not to a human', async () => {
    const { db, sellerId } = await makeTestDb();
    await createAutoPostRule(db, {
      id: 'rule_attrib',
      seller_id: sellerId,
      name: 'Attribution',
      proposal_kind: 'record_fee',
      match: { description: 'Card processing fee' },
      enabled: true,
      created_by: OWNER.id,
    });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_fee',
      seller_id: sellerId,
      amount_cents: 2700,
      description: 'Card processing fee',
    });
    await postLedgerUpdate(db, AGENT, proposal.id);

    const row = await db.get(`SELECT approval_basis, auto_rule_id FROM ledger_proposals WHERE id = ?`, [proposal.id]) as { approval_basis: string; auto_rule_id: string };
    expect(row.approval_basis).toBe('auto_rule');
    expect(row.auto_rule_id).toBe('rule_attrib');
  });
});
