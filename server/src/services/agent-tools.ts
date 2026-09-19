/**
 * Agent tools.
 *
 * The five tools the requirements name, exposed as a registry so an agent can
 * discover and call them, and so the HTTP layer can serve the same operations
 * without a second implementation.
 *
 * Every tool routes through the same service functions the UI uses, which is
 * the point: the approval rules are enforced in the service layer, so an
 * agent calling a tool is subject to exactly the same controls as a human
 * clicking a button. There is no "agent mode" that relaxes a check.
 *
 * Two rules the agent cannot escape, because they live in ledger.ts:
 *   - an agent may never approve a proposal (approve requires a human)
 *   - an agent may never post a proposal it proposed itself, unless an
 *     enabled exact-match auto-post rule authorises that specific operation
 */

import type { Db } from '../db';
import { ZodError, z } from 'zod';
import { LedgerError, isLedgerError } from '../domain/errors';
import type { Actor } from '../domain/types';
import {
  approveLedgerUpdate,
  getProposalForActor,
  listProposals,
  postLedgerUpdate,
  previewLedgerUpdate,
  proposeLedgerUpdate,
  reverseLedgerEntry,
  type PostResult,
} from './ledger';
import { planOperation, type OperationInput } from './plan';

// ───────────────────────────── schemas ──────────────────────────────────

const cents = z
  .number()
  .int('amounts must be integer cents')
  .positive('amounts must be positive');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'expected an ISO date');

const operationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('record_payment'),
    seller_id: z.string().min(1),
    amount_cents: cents,
    received_at: isoDate,
    currency: z.string().optional(),
    reference: z.string().nullish(),
    payer_name: z.string().nullish(),
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('allocate_payment'),
    seller_id: z.string().min(1),
    payment_id: z.string().min(1),
    invoice_id: z.string().min(1),
    amount_cents: cents,
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('apply_credit_note'),
    seller_id: z.string().min(1),
    invoice_id: z.string().min(1),
    amount_cents: cents,
    reason: z.string().nullish(),
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('record_fee'),
    seller_id: z.string().min(1),
    payment_id: z.string().nullish(),
    amount_cents: cents,
    description: z.string().min(1),
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('record_refund'),
    seller_id: z.string().min(1),
    payment_id: z.string().min(1),
    invoice_id: z.string().nullish(),
    amount_cents: cents,
    reason: z.string().nullish(),
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('post_adjustment'),
    seller_id: z.string().min(1),
    adjustment_id: z.string().min(1),
    source_event_id: z.string().optional(),
  }),
  z.object({
    kind: z.literal('issue_invoice'),
    seller_id: z.string().min(1),
    invoice_id: z.string().min(1),
    source_event_id: z.string().optional(),
  }),
]);

export type OperationSchemaInput = z.infer<typeof operationSchema>;

// ───────────────────────────── tool defs ────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Tools that change financial state require seller approval first. */
  mutates_ledger: boolean;
  /** True for tools an agent is structurally forbidden from calling. */
  requires_human: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'propose_ledger_update',
    description:
      'Propose a ledger update (record a payment, allocate a payment to an ' +
      'invoice, apply a credit note, record a fee or refund, or post an ' +
      'approved adjustment). Creates a proposal only — nothing is posted and ' +
      'no financial record changes. A seller user must approve it before it ' +
      'can be posted, unless an enabled exact-match auto-post rule covers it.',
    mutates_ledger: false,
    requires_human: false,
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'object', description: 'The ledger operation to propose.' },
        idempotency_key: {
          type: 'string',
          description:
            'Optional caller-supplied retry key. Reusing a key returns the ' +
            'original proposal instead of creating a duplicate.',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'preview_ledger_update',
    description:
      'Show exactly what a ledger update would do without creating anything: ' +
      'the proposed debit and credit lines, the affected invoices, the ' +
      'resulting balance changes and the supporting source records. Use this ' +
      'before proposing so the seller can see the effect.',
    mutates_ledger: false,
    requires_human: false,
    input_schema: {
      type: 'object',
      properties: { operation: { type: 'object' } },
      required: ['operation'],
    },
  },
  {
    name: 'approve_ledger_update',
    description:
      'Record seller approval for a proposal so it can be posted. This is a ' +
      'seller decision and must be made by a human with an approver or owner ' +
      'role. An agent cannot call this, and nobody may approve a proposal they ' +
      'raised themselves.',
    mutates_ledger: true,
    requires_human: true,
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'post_ledger_update',
    description:
      'Commit an approved proposal. Revalidates payment state, remaining ' +
      'balances and record versions immediately before committing, then writes ' +
      'the journal entry, the subledger change, the invoice balances and the ' +
      'audit event in one transaction. Refuses to post an unapproved proposal ' +
      'that no auto-post rule covers.',
    mutates_ledger: true,
    requires_human: false,
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string' },
        idempotency_key: {
          type: 'string',
          description: 'Retry key; reusing it replays the original posting.',
        },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'reverse_ledger_entry',
    description:
      'Reverse a posted journal entry by posting its exact negation and ' +
      'marking the original reversed. Posted entries are never edited or ' +
      'deleted. Reversing a reversal is not permitted — post a replacement ' +
      'entry instead. A reason is required.',
    mutates_ledger: true,
    requires_human: false,
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['entry_id', 'reason'],
    },
  },
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

// ─────────────────────────── error shaping ──────────────────────────────

/** Turn any thrown value into a tool result the agent can act on. */
function toToolError(err: unknown): {
  ok: false;
  error: { code: string; message: string; detail?: unknown };
} {
  if (isLedgerError(err)) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      },
    };
  }
  if (err instanceof ZodError) {
    return {
      ok: false,
      error: {
        code: 'validation',
        message: 'the operation is malformed',
        detail: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

// ───────────────────────────── dispatch ─────────────────────────────────

export type ToolName =
  | 'propose_ledger_update'
  | 'preview_ledger_update'
  | 'approve_ledger_update'
  | 'post_ledger_update'
  | 'reverse_ledger_entry';

export interface ToolCallResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: { code: string; message: string; detail?: unknown };
}

/**
 * Call a tool as a given actor.
 *
 * Note there is no branch here that grants an agent extra latitude. The
 * `requires_human` flag on approve_ledger_update is enforced in the service
 * layer *and* checked here, because a tool registry is the natural place for
 * an agent's capabilities to be described, and describing a capability it
 * does not have would be misleading.
 */
export function callTool(
  db: Db,
  actor: Actor,
  toolName: string,
  args: unknown,
): ToolCallResult {
  try {
    const definition = getToolDefinition(toolName);
    if (!definition) {
      throw new LedgerError('not_found', `unknown tool '${toolName}'`);
    }
    if (definition.requires_human && actor.kind !== 'human') {
      throw new LedgerError(
        'self_approval',
        `tool '${toolName}' requires a human actor; agents cannot perform it`,
      );
    }

    const input = (args ?? {}) as Record<string, unknown>;

    switch (toolName as ToolName) {
      case 'preview_ledger_update': {
        const op = operationSchema.parse(input.operation) as OperationInput;
        const preview = previewLedgerUpdate(db, actor, op);
        // Previewing does not persist anything, but the returned lines have
        // already been balance-checked by buildLines.
        return { ok: true, tool: toolName, result: { preview } };
      }

      case 'propose_ledger_update': {
        const op = operationSchema.parse(input.operation) as OperationInput;
        const idempotencyKey =
          typeof input.idempotency_key === 'string' ? input.idempotency_key : null;
        const proposal = proposeLedgerUpdate(db, actor, op, { idempotencyKey });
        return {
          ok: true,
          tool: toolName,
          result: {
            proposal_id: proposal.id,
            status: proposal.status,
            proposal_kind: proposal.proposal_kind,
            source_event_id: proposal.source_event_id,
            requires_approval: proposal.status === 'proposed',
            preview: proposal.preview,
            next_step:
              proposal.status === 'proposed'
                ? 'A seller user must approve this proposal (approve_ledger_update) ' +
                  'before it can be posted, unless an exact-match auto-post rule applies.'
                : 'This proposal can be posted.',
          },
        };
      }

      case 'approve_ledger_update': {
        const proposalId = z.string().min(1).parse(input.proposal_id);
        const reason = typeof input.reason === 'string' ? input.reason : undefined;
        const proposal = approveLedgerUpdate(
          db,
          actor,
          proposalId,
          reason !== undefined ? { reason } : {},
        );
        return {
          ok: true,
          tool: toolName,
          result: {
            proposal_id: proposal.id,
            status: proposal.status,
            approved_by: proposal.approved_by,
            approval_basis: proposal.approval_basis,
          },
        };
      }

      case 'post_ledger_update': {
        const proposalId = z.string().min(1).parse(input.proposal_id);
        const idempotencyKey =
          typeof input.idempotency_key === 'string' ? input.idempotency_key : null;
        const postResult: PostResult = postLedgerUpdate(db, actor, proposalId, {
          idempotencyKey,
        });
        const entry = db
          .prepare(
            `SELECT id, entry_no, external_sync_state FROM journal_entries WHERE id = ?`,
          )
          .get(postResult.entry_id) as {
          id: string;
          entry_no: number;
          external_sync_state: string;
        };
        return {
          ok: true,
          tool: toolName,
          result: {
            proposal_id: proposalId,
            entry_id: entry.id,
            entry_no: entry.entry_no,
            replayed: postResult.replayed,
            external_sync_state: entry.external_sync_state,
            external_note:
              entry.external_sync_state === 'not_applicable'
                ? 'No external accounting platform is connected; the local ledger is authoritative.'
                : 'Recorded locally and awaiting confirmation from the external accounting platform.',
            reminders: postResult.reminders,
          },
        };
      }

      case 'reverse_ledger_entry': {
        const entryId = z.string().min(1).parse(input.entry_id);
        const reason = z.string().min(1).parse(input.reason);
        const result = reverseLedgerEntry(db, actor, entryId, reason);
        return {
          ok: true,
          tool: toolName,
          result: {
            reversal_entry_id: result.reversal_entry_id,
            reverses_entry_id: result.reverses_entry_id,
            reminders: result.reminders,
          },
        };
      }

      default:
        throw new LedgerError('not_found', `unknown tool '${toolName}'`);
    }
  } catch (err) {
    return { ok: false, tool: toolName, error: toToolError(err).error };
  }
}

/**
 * A dry-run plan for a proposal the agent has already raised, so it can
 * explain the effect of something already in flight.
 */
export function explainProposal(db: Db, actor: Actor, proposalId: string) {
  const proposal = getProposalForActor(db, actor, proposalId);
  const op = JSON.parse(
    (db
      .prepare(`SELECT operation_json FROM ledger_proposals WHERE id = ?`)
      .get(proposalId) as { operation_json: string }).operation_json,
  ) as OperationInput;
  // Re-plan against live state so drift between propose and now is visible.
  const live = planOperation(db, op);
  return { proposal, live_preview: live.preview };
}

export { listProposals };
