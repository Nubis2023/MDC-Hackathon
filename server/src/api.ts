/**
 * HTTP API.
 *
 * Authentication is deliberately trivial (an X-Actor-Id header naming a seeded
 * user) because identity is not what this service is about — but the
 * *authorisation* is real: every route resolves an actor and goes through the
 * same service-layer access checks the agent tools use. Swapping the header
 * for a session lookup would not change any of the controls below it.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from './db';
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
import { listInvoices } from './services/invoices';
import { listPayments } from './services/payments';
import {
  accountBalances,
  reconcileSeller,
} from './services/reconciliation';
import { listOutstandingReminders, listReminders } from './services/reminders';
import { newId } from './services/ids';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

function loadActor(db: Db, req: Request): Actor | null {
  const headerId = req.header('x-actor-id');
  const id = headerId ?? 'user_owner_1';
  const row = db
    .prepare(`SELECT id, name, kind FROM users WHERE id = ?`)
    .get(id) as Actor | undefined;
  return row ?? null;
}

export function createApp(db: Db): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ── Actor resolution ─────────────────────────────────────────────────
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const actor = loadActor(db, req);
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
  });

  const actorOf = (req: Request): Actor => {
    if (!req.actor) {
      throw new LedgerError('forbidden', 'no actor on request');
    }
    return req.actor;
  };

  // ── Health & bootstrap ───────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'seller-ledger', time: new Date().toISOString() });
  });

  app.get('/api/bootstrap', (req, res) => {
    const actor = actorOf(req);
    const sellerIds = accessibleSellerIds(db, actor);
    const sellers = sellerIds.map((id) => {
      const seller = db
        .prepare(`SELECT id, name, currency, authoritative_system FROM sellers WHERE id = ?`)
        .get(id) as {
        id: string;
        name: string;
        currency: string;
        authoritative_system: 'local' | 'external';
      };
      return {
        ...seller,
        role: getMembership(db, id, actor.id)?.role ?? null,
        posture: getLedgerPosture(db, id),
      };
    });
    const users = db
      .prepare(`SELECT id, name, kind FROM users ORDER BY kind, name`)
      .all() as Actor[];
    res.json({ actor, sellers, users });
  });

  // ── Reconciliation interface ─────────────────────────────────────────
  app.get('/api/sellers/:sellerId/reconciliation', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    const { summary, rows } = reconcileSeller(db, sellerId);
    res.json({
      summary,
      rows,
      accounts: accountBalances(db, sellerId),
      posture: getLedgerPosture(db, sellerId),
    });
  });

  // ── Invoices & payments ──────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/invoices', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({ invoices: listInvoices(db, { sellerId }) });
  });

  app.get('/api/sellers/:sellerId/payments', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({ payments: listPayments(db, sellerId) });
  });

  // ── Proposals: preview, propose, approve, reject, post ───────────────
  app.post('/api/sellers/:sellerId/proposals/preview', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    const operation = { ...req.body.operation, seller_id: sellerId };
    res.json({ preview: previewLedgerUpdate(db, actor, operation) });
  });

  app.post('/api/sellers/:sellerId/proposals', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    const operation = { ...req.body.operation, seller_id: sellerId };
    const proposal = proposeLedgerUpdate(db, actor, operation, {
      idempotencyKey: req.body.idempotency_key ?? null,
    });
    res.status(201).json({ proposal });
  });

  app.get('/api/sellers/:sellerId/proposals', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const proposals = listProposals(
      db,
      actor,
      sellerId,
      status as never,
    );
    res.json({ proposals, summaries: listProposalSummaries(db, sellerId) });
  });

  app.get('/api/proposals/:proposalId', (req, res) => {
    const actor = actorOf(req);
    res.json({ proposal: getProposalForActor(db, actor, req.params.proposalId) });
  });

  app.post('/api/proposals/:proposalId/approve', (req, res) => {
    const actor = actorOf(req);
    const result = callTool(db, actor, 'approve_ledger_update', {
      proposal_id: req.params.proposalId,
      ...(typeof req.body.reason === 'string' ? { reason: req.body.reason } : {}),
    });
    if (!result.ok) {
      res.status(result.error?.code === 'self_approval' ? 403 : 400).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/api/proposals/:proposalId/post', (req, res) => {
    const actor = actorOf(req);
    const result = callTool(db, actor, 'post_ledger_update', {
      proposal_id: req.params.proposalId,
      ...(typeof req.body.idempotency_key === 'string'
        ? { idempotency_key: req.body.idempotency_key }
        : {}),
    });
    if (!result.ok) {
      res.status(result.error?.code === 'not_approved' ? 403 : 409).json(result);
      return;
    }
    res.json(result);
  });

  // Rejections are not a ledger write, so they go straight to the service.
  app.post('/api/proposals/:proposalId/reject', (req, res) => {
    const actor = actorOf(req);
    res.json({
      proposal: rejectLedgerUpdate(
        db,
        actor,
        req.params.proposalId,
        typeof req.body.reason === 'string' ? req.body.reason : 'no reason given',
      ),
    });
  });

  // ── Journal ──────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/journal', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({
      entries: listJournalEntries(db, {
        sellerId,
        ...(typeof req.query.source_type === 'string'
          ? { sourceType: req.query.source_type }
          : {}),
      }),
      reversible: listReversibleEntries(db, sellerId).map((e) => ({
        id: e.id,
        entry_no: e.entry_no,
        memo: e.memo,
      })),
    });
  });

  app.get('/api/journal/:entryId', (req, res) => {
    const actor = actorOf(req);
    const entry = getEntryForActor(db, actor, req.params.entryId);
    res.json({ entry, sync_attempts: listSyncAttempts(db, entry.id) });
  });

  app.post('/api/journal/:entryId/reverse', (req, res) => {
    const actor = actorOf(req);
    const result = callTool(db, actor, 'reverse_ledger_entry', {
      entry_id: req.params.entryId,
      reason: req.body.reason,
    });
    if (!result.ok) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  });

  // ── Adjustments ──────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/adjustments', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({ adjustments: listAdjustments(db, sellerId) });
  });

  app.post('/api/sellers/:sellerId/adjustments', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    const adjustment = createAdjustment(db, actor, {
      seller_id: sellerId,
      invoice_id: req.body.invoice_id ?? null,
      amount_cents: req.body.amount_cents,
      direction: req.body.direction,
      mapping_key: req.body.mapping_key,
      memo: req.body.memo,
    });
    res.status(201).json({ adjustment });
  });

  app.post('/api/sellers/:sellerId/adjustments/:adjustmentId/approve', (req, res) => {
    const actor = actorOf(req);
    const adjustment = approveAdjustment(
      db,
      actor,
      req.params.sellerId,
      req.params.adjustmentId,
    );
    res.json({ adjustment });
  });

  // ── Reminders ────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/reminders', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({
      reminders: listReminders(db, sellerId),
      outstanding: listOutstandingReminders(db, sellerId),
    });
  });

  // ── Audit ────────────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/audit', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({ events: listAuditEvents(db, sellerId) });
  });

  // ── External sync ────────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/sync', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({
      posture: getLedgerPosture(db, sellerId),
      pending: listPendingSyncEntries(db, sellerId),
    });
  });

  app.post('/api/journal/:entryId/sync-attempt', (req, res) => {
    const actor = actorOf(req);
    const entry = getEntryForActor(db, actor, req.params.entryId);
    const id = recordSyncAttempt(db, {
      sellerId: entry.seller_id,
      entryId: entry.id,
      platform: req.body.platform ?? 'demo-accounting-platform',
      state: req.body.state,
      externalRef: req.body.external_ref ?? null,
      errorMessage: req.body.error_message ?? null,
      actor,
    });
    res.status(201).json({ sync_attempt_id: id, entry: getEntryForActor(db, actor, entry.id) });
  });

  // ── Auto-post rules ──────────────────────────────────────────────────
  app.get('/api/sellers/:sellerId/auto-post-rules', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    res.json({ rules: listAutoPostRules(db, sellerId) });
  });

  app.post('/api/sellers/:sellerId/auto-post-rules', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    const id = newId('rule');
    createAutoPostRule(db, {
      id,
      seller_id: sellerId,
      name: req.body.name,
      proposal_kind: req.body.proposal_kind,
      match: req.body.match,
      max_amount_cents: req.body.max_amount_cents ?? null,
      enabled: Boolean(req.body.enabled),
      created_by: actor.id,
    });
    res.status(201).json({ rule_id: id, rules: listAutoPostRules(db, sellerId) });
  });

  app.post('/api/sellers/:sellerId/auto-post-rules/:ruleId/enabled', (req, res) => {
    const actor = actorOf(req);
    const sellerId = req.params.sellerId;
    assertSellerAccess(db, sellerId, actor);
    setAutoPostRuleEnabled(db, sellerId, req.params.ruleId, Boolean(req.body.enabled));
    res.json({ rules: listAutoPostRules(db, sellerId) });
  });

  // ── Agent tools ──────────────────────────────────────────────────────
  app.get('/api/agent/tools', (_req, res) => {
    res.json({ tools: describeTools() });
  });

  app.post('/api/agent/tools/:toolName', (req, res) => {
    const actor = actorOf(req);
    const result = callTool(db, actor, req.params.toolName, req.body);
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
  });

  // ── Static UI ────────────────────────────────────────────────────────
  // The built frontend is served from the same origin as the API so there is
  // one URL to open and no CORS or proxy configuration in the way. Registered
  // after every /api route, so an API path is never shadowed by a static file.
  const webDist = process.env.WEB_DIST ?? resolve(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback for client-side routes, excluding /api.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  // ── Error handling ───────────────────────────────────────────────────
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
