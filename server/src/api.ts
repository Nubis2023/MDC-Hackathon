/**
 * HTTP API.
 *
 * Authentication is deliberately trivial (an X-Actor-Id header naming a seeded
 * user) because identity is not what this service is about — but the
 * *authorisation* is real: every route resolves an actor and goes through the
 * same service-layer access checks the agent tools use. Swapping the header
 * for a session lookup would not change any of the controls below it.
 */

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SqlDb } from './db';
import { isLedgerError, LedgerError } from './domain/errors';
import type { Actor } from './domain/types';
import {
  approveAdjustment,
  createAdjustment,
  listAdjustments,
} from './services/adjustments';
import {
  accessibleSellerIds,
  assertSellerAccess,
  getMembership,
} from './services/access';
import { listAuditEvents } from './services/audit';
import {
  callTool,
  describeTools,
  listProposalSummaries,
} from './services/api-support';
import {
  createAutoPostRule,
  listAutoPostRules,
  setAutoPostRuleEnabled,
} from './services/auto-post';
import {
  getLedgerPosture,
  listPendingSyncEntries,
  listSyncAttempts,
  recordSyncAttempt,
} from './services/external-sync';
import { listJournalEntries } from './services/journal';
import {
  getEntryForActor,
  getProposalForActor,
  listProposals,
  listReversibleEntries,
  previewLedgerUpdate,
  proposeLedgerUpdate,
  rejectLedgerUpdate,
} from './services/ledger';
import { createInvoice, listInvoices } from './services/invoices';
import { listPayments } from './services/payments';
import {
  accountBalances,
  reconcileSeller,
} from './services/reconciliation';
import { listOutstandingReminders, listReminders } from './services/reminders';
import { newId } from './services/ids';

/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 does not await a handler that returns a promise: a thrown error
 * inside an async handler becomes an unhandled rejection and the request
 * hangs. This forwards it to the error middleware, which is where the
 * LedgerError -> HTTP status mapping lives.
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

async function loadActor(db: SqlDb, req: Request): Promise<Actor | null>{
  const headerId = req.header('x-actor-id');
  const id = headerId ?? 'user_owner_1';
  const row = await db.get(`SELECT id, name, kind FROM users WHERE id = ?`, [id]) as Actor | undefined;
  return row ?? null;
}

/**
 * Build the Express app.
 *
 * Synchronous: nothing here awaits at construction time — only the route
 * handlers do, and they are async. Returning a promise would force every
 * caller to await before `listen`, for no benefit.
 */
export function createApp(db: SqlDb): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ── Actor resolution ─────────────────────────────────────────────────
  app.use(asyncHandler(async (req, res, next) => {
    if (req.path === '/api/health') return next();
    const actor = await loadActor(db, req);
    if (!actor) {
      res.status(401).json({
        error: {
          code: 'forbidden',
          message: `unknown actor '${req.header('x-actor-id') ?? 'user_owner_1'}'`,
        },
      });
      return;
    }
    req.actor = actor;
    next();
  }));

  const actorOf = (req: Request): Actor => {
    if (!req.actor) {
      throw new LedgerError('forbidden', 'no actor on request');
    }
    return req.actor;
  };

  // ── Health & bootstrap ───────────────────────────────────────────────
  app.get('/api/health',asyncHandler( async (_req, res) => {
    res.json({ ok: true, service: 'seller-ledger', time: new Date().toISOString() });
  }));

  app.get('/api/bootstrap',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerIds = await accessibleSellerIds(db, actor);
    // Promise.all is required: `map(async …)` yields an array of pending
    // promises, and JSON.stringify renders those as `{}` — so the response
    // silently carried empty seller objects rather than the sellers.
    const sellers = await Promise.all(
      sellerIds.map(async (id) => {
        const seller = (await db.get(
          `SELECT id, name, currency, authoritative_system FROM sellers WHERE id = ?`,
          [id],
        )) as {
          id: string;
          name: string;
          currency: string;
          authoritative_system: 'local' | 'external';
        };
        return {
          ...seller,
          role: (await getMembership(db, id, actor.id))?.role ?? null,
          posture: await getLedgerPosture(db, id),
        };
      }),
    );
    const users = (await db.all(
      `SELECT id, name, kind FROM users ORDER BY kind, name`,
    )) as Actor[];
    res.json({ actor, sellers, users });
  }));

  // ── Reconciliation interface ─────────────────────────────────────────
  app.get('/api/sellers/:sellerId/reconciliation',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    const { summary, rows } = await reconcileSeller(db, sellerId);
    res.json({
      summary,
      rows,
      accounts: await accountBalances(db, sellerId),
      posture: await getLedgerPosture(db, sellerId),
    });
  }));

  // ── Invoices & payments ──────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/invoices',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({ invoices: await listInvoices(db, { sellerId }) });
  }));

  /**
   * Place an invoice: create the document and its reminder ladder.
   *
   * Deliberately does NOT post to the ledger. Putting the receivable on the
   * books is a separate step through the normal propose/approve/post flow
   * (issue_invoice), so the accounting entry is reviewable and sits behind the
   * same approval gate as every other posting.
   */
  app.post('/api/sellers/:sellerId/invoices',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);

    const invoice = await createInvoice(db, actor, {
      seller_id: sellerId,
      customer_name: req.body.customer_name,
      number: req.body.number,
      issue_date: req.body.issue_date,
      due_date: req.body.due_date,
      currency: req.body.currency,
      subtotal_cents: req.body.subtotal_cents,
      tax_cents: req.body.tax_cents,
    });

    // The next step is a separate, reviewable proposal, so hand the caller
    // everything needed to raise it without a second round trip.
    const nextOperation = {
      kind: 'issue_invoice',
      seller_id: sellerId,
      invoice_id: invoice.id,
    };

    res.status(201).json({
      invoice,
      next_operation: nextOperation,
      next_step:
        'Raise an issue_invoice proposal for this invoice to put the ' +
        'receivable on the ledger. It requires approval before it can post.',
    });
  }));

  app.get('/api/sellers/:sellerId/payments',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({ payments: await listPayments(db, sellerId) });
  }));

  // ── Proposals: preview, propose, approve, reject, post ───────────────
  app.post('/api/sellers/:sellerId/proposals/preview',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    const operation = { ...req.body.operation, seller_id: sellerId };
    res.json({ preview: await previewLedgerUpdate(db, actor, operation) });
  }));

  app.post('/api/sellers/:sellerId/proposals',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    const operation = { ...req.body.operation, seller_id: sellerId };
    const proposal = await proposeLedgerUpdate(db, actor, operation, {
      idempotencyKey: req.body.idempotency_key ?? null,
    });
    res.status(201).json({ proposal });
  }));

  app.get('/api/sellers/:sellerId/proposals',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const proposals = await listProposals(
      db,
      actor,
      sellerId,
      status as never,
    );
    res.json({ proposals, summaries: await listProposalSummaries(db, sellerId) });
  }));

  app.get('/api/proposals/:proposalId',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    res.json({ proposal: await getProposalForActor(db, actor, String(req.params.proposalId ?? "")) });
  }));

  app.post('/api/proposals/:proposalId/approve',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const result = await callTool(db, actor, 'approve_ledger_update', {
      proposal_id: String(req.params.proposalId ?? ""),
      ...(typeof req.body.reason === 'string' ? { reason: req.body.reason } : {}),
    });
    if (!result.ok) {
      res.status(result.error?.code === 'self_approval' ? 403 : 400).json(result);
      return;
    }
    res.json(result);
  }));

  app.post('/api/proposals/:proposalId/post',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const result = await callTool(db, actor, 'post_ledger_update', {
      proposal_id: String(req.params.proposalId ?? ""),
      ...(typeof req.body.idempotency_key === 'string'
        ? { idempotency_key: req.body.idempotency_key }
        : {}),
    });
    if (!result.ok) {
      res.status(result.error?.code === 'not_approved' ? 403 : 409).json(result);
      return;
    }
    res.json(result);
  }));

  // Rejections are not a ledger write, so they go straight to the service.
  app.post('/api/proposals/:proposalId/reject',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    res.json({
      proposal: await rejectLedgerUpdate(
        db,
        actor,
        String(req.params.proposalId ?? ""),
        typeof req.body.reason === 'string' ? req.body.reason : 'no reason given',
      ),
    });
  }));

  // ── Journal ──────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/journal',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({
      entries: await listJournalEntries(db, {
        sellerId,
        ...(typeof req.query.source_type === 'string'
          ? { sourceType: req.query.source_type }
          : {}),
      }),
      reversible: (await listReversibleEntries(db, sellerId)).map((e) => ({
        id: e.id,
        entry_no: e.entry_no,
        memo: e.memo,
      })),
    });
  }));

  app.get('/api/journal/:entryId',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const entry = await getEntryForActor(db, actor, String(req.params.entryId ?? ""));
    res.json({ entry, sync_attempts: await listSyncAttempts(db, entry.id) });
  }));

  app.post('/api/journal/:entryId/reverse',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const result = await callTool(db, actor, 'reverse_ledger_entry', {
      entry_id: String(req.params.entryId ?? ""),
      reason: req.body.reason,
    });
    if (!result.ok) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  }));

  // ── Adjustments ──────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/adjustments',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({ adjustments: await listAdjustments(db, sellerId) });
  }));

  app.post('/api/sellers/:sellerId/adjustments',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    const adjustment = await createAdjustment(db, actor, {
      seller_id: sellerId,
      invoice_id: req.body.invoice_id ?? null,
      amount_cents: req.body.amount_cents,
      direction: req.body.direction,
      mapping_key: req.body.mapping_key,
      memo: req.body.memo,
    });
    res.status(201).json({ adjustment });
  }));

  app.post('/api/sellers/:sellerId/adjustments/:adjustmentId/approve',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const adjustment = await approveAdjustment(
      db,
      actor,
      String(req.params.sellerId ?? ''),
      String(req.params.adjustmentId ?? ''),
    );
    res.json({ adjustment });
  }));

  // ── Reminders ────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/reminders',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({
      reminders: await listReminders(db, sellerId),
      outstanding: await listOutstandingReminders(db, sellerId),
    });
  }));

  // ── Audit ────────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/audit',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({ events: await listAuditEvents(db, sellerId) });
  }));

  // ── External sync ────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/sync',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({
      posture: await getLedgerPosture(db, sellerId),
      pending: await listPendingSyncEntries(db, sellerId),
    });
  }));

  app.post('/api/journal/:entryId/sync-attempt',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const entry = await getEntryForActor(db, actor, String(req.params.entryId ?? ""));
    const id = await recordSyncAttempt(db, {
      sellerId: entry.seller_id,
      entryId: entry.id,
      platform: req.body.platform ?? 'demo-accounting-platform',
      state: req.body.state,
      externalRef: req.body.external_ref ?? null,
      errorMessage: req.body.error_message ?? null,
      actor,
    });
    res.status(201).json({ sync_attempt_id: id, entry: await getEntryForActor(db, actor, entry.id) });
  }));

  // ── Auto-post rules ──────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/auto-post-rules',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    res.json({ rules: await listAutoPostRules(db, sellerId) });
  }));

  app.post('/api/sellers/:sellerId/auto-post-rules',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    const id = newId('rule');
    await createAutoPostRule(db, {
      id,
      seller_id: sellerId,
      name: req.body.name,
      proposal_kind: req.body.proposal_kind,
      match: req.body.match,
      max_amount_cents: req.body.max_amount_cents ?? null,
      enabled: Boolean(req.body.enabled),
      created_by: actor.id,
    });
    res.status(201).json({ rule_id: id, rules: await listAutoPostRules(db, sellerId) });
  }));

  app.post('/api/sellers/:sellerId/auto-post-rules/:ruleId/enabled',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const sellerId = String(req.params.sellerId ?? "");
    await assertSellerAccess(db, sellerId, actor);
    await setAutoPostRuleEnabled(db, sellerId, String(req.params.ruleId ?? ""), Boolean(req.body.enabled));
    res.json({ rules: await listAutoPostRules(db, sellerId) });
  }));

  // ── Agent tools ──────────────────────────────────────────────────────
  app.get('/api/agent/tools',asyncHandler( async (_req, res) => {
    res.json({ tools: await describeTools() });
  }));

  app.post('/api/agent/tools/:toolName',asyncHandler( async (req, res) => {
    const actor = actorOf(req);
    const result = await callTool(db, actor, String(String(req.params.toolName ?? "") ?? ""), req.body);
    if (!result.ok) {
      const status =
        result.error?.code === 'forbidden' || result.error?.code === 'self_approval'
          ? 403
          : result.error?.code === 'not_found'
            ? 404
            : 400;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  }));

  // ── Static UI ────────────────────────────────────────────────────────
  // The built frontend is served from the same origin as the API so there is
  // one URL to open and no CORS or proxy configuration in the way. Registered
  // after every /api route, so an API path is never shadowed by a static file.
  const webDist = process.env.WEB_DIST ?? resolve(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback for client-side routes, excluding /api.
    app.get(/^(?!\/api).*/,asyncHandler( async (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    }));
  }

  // ── Error handling ───────────────────────────────────────────────────
  // Express identifies error middleware by arity (4 params), so this must NOT
  // be wrapped in asyncHandler — that would produce a 3-param function and
  // Express would treat it as ordinary middleware, silently swallowing errors.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isLedgerError(err)) {
      res.status(err.httpStatus).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.detail !== undefined ? { detail: err.detail } : {}),
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: { code: 'internal', message } });
  });

  return app;
}
