/**
 * External accounting system synchronisation.
 *
 * Covers the requirement to distinguish the local operational ledger from any
 * external accounting system, to track sync as pending/confirmed/failed, and
 * above all to never claim the external ledger was updated until the platform
 * confirms it.
 */

import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors';
import {
  approveLedgerUpdate,
  postLedgerUpdate,
  proposeLedgerUpdate,
} from '../src/services/ledger';
import {
  getLedgerPosture,
  initialSyncStateForSeller,
  listPendingSyncEntries,
  listSyncAttempts,
  recordSyncAttempt,
} from '../src/services/external-sync';
import { getJournalEntry } from '../src/services/journal';
import { listAuditEvents } from '../src/services/audit';
import { callTool } from '../src/services/agent-tools';
import { AGENT, APPROVER, BOOKKEEPER, makeTestDb } from './helpers';

describe('external sync state', async () => {
  it('reports not_applicable when the local ledger is authoritative', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'local' });
    const posture = await getLedgerPosture(db, sellerId);
    expect(posture.authoritative_system).toBe('local');
    expect(posture.local_ledger_is_authoritative).toBe(true);
    expect(posture.note).toMatch(/local operational ledger is authoritative/);
    expect(await initialSyncStateForSeller(db, sellerId)).toBe('not_applicable');
  });

  it('reports pending when an external platform is authoritative', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const posture = await getLedgerPosture(db, sellerId);
    expect(posture.local_ledger_is_authoritative).toBe(false);
    expect(posture.note).toMatch(/provisional until the platform confirms/);
    expect(await initialSyncStateForSeller(db, sellerId)).toBe('pending');
  });

  it('marks a posting pending, never confirmed, when external is authoritative', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const result = await postLedgerUpdate(db, APPROVER, proposal.id);

    const entry = await getJournalEntry(db, result.entry_id)!;
    // The local posting succeeded, but the external ledger has NOT been
    // updated — it is awaiting confirmation.
    expect(entry.external_sync_state).toBe('pending');
    expect(entry.external_ref).toBeNull();
    expect(entry.external_synced_at).toBeNull();
  });

  it('refuses to mark a sync confirmed without a platform reference', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    await expect(recordSyncAttempt(db, {
        sellerId,
        entryId: entry_id,
        platform: 'demo-platform',
        state: 'confirmed',
        externalRef: null,
        actor: APPROVER,
      }),).rejects.toThrowError(/requires a platform-issued external_ref/);

    // And the entry must still be pending — the failed claim changed nothing.
    expect((await getJournalEntry(db, entry_id))!.external_sync_state).toBe('pending');
  });

  it('records a confirmed sync once the platform supplies a reference', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'confirmed',
      externalRef: 'PLATFORM-JE-9981',
      response: { accepted: true },
      actor: APPROVER,
    });

    const entry = await getJournalEntry(db, entry_id)!;
    expect(entry.external_sync_state).toBe('confirmed');
    expect(entry.external_ref).toBe('PLATFORM-JE-9981');
    expect(entry.external_synced_at).not.toBeNull();
  });

  it('records a failed sync with the error and keeps the entry recoverable', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'failed',
      errorMessage: 'platform returned 503',
      actor: APPROVER,
    });

    const entry = await getJournalEntry(db, entry_id)!;
    expect(entry.external_sync_state).toBe('failed');
    expect(entry.external_error).toBe('platform returned 503');
    // The local posting still stands: a sync failure is not a ledger failure.
    expect(entry.status).toBe('posted');
  });

  it('keeps the full attempt history, not just the latest state', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'failed',
      errorMessage: 'timeout',
      actor: APPROVER,
    });
    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'confirmed',
      externalRef: 'PLATFORM-JE-2',
      actor: APPROVER,
    });

    const attempts = await listSyncAttempts(db, entry_id);
    expect(attempts).toHaveLength(2);
    // Newest first.
    expect(attempts[0]!.state).toBe('confirmed');
    expect(attempts[1]!.state).toBe('failed');
    expect(attempts[1]!.error_message).toBe('timeout');
  });

  it('lists entries awaiting confirmation as the sync backlog', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    const pending = await listPendingSyncEntries(db, sellerId);
    expect(pending.map((p) => p.id)).toContain(entry_id);

    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'confirmed',
      externalRef: 'PLATFORM-JE-3',
      actor: APPROVER,
    });

    expect((await listPendingSyncEntries(db, sellerId)).map((p) => p.id)).not.toContain(
      entry_id,
    );
  });

  it('never claims an external update for a locally authoritative seller', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'local' });
    const proposal = await proposeLedgerUpdate(db, BOOKKEEPER, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    const entry = await getJournalEntry(db, entry_id)!;
    expect(entry.external_sync_state).toBe('not_applicable');
    expect(entry.external_ref).toBeNull();
    // Nothing is in the sync backlog because there is no platform.
    expect(await listPendingSyncEntries(db, sellerId)).toHaveLength(0);
  });

  it('refuses to sync an entry that is not posted', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    await expect(recordSyncAttempt(db, {
        sellerId,
        entryId: 'je_missing',
        platform: 'demo-platform',
        state: 'pending',
        actor: APPROVER,
      }),).rejects.toThrowError(/not found/);
  });

  it('audits each sync transition', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });
    const proposal = await proposeLedgerUpdate(db, AGENT, {
      kind: 'record_payment',
      seller_id: sellerId,
      amount_cents: 5000,
      received_at: '2026-09-01T12:00:00.000Z',
    });
    await approveLedgerUpdate(db, APPROVER, proposal.id, { reason: 'test' });
    const { entry_id } = await postLedgerUpdate(db, APPROVER, proposal.id);

    await recordSyncAttempt(db, {
      sellerId,
      entryId: entry_id,
      platform: 'demo-platform',
      state: 'confirmed',
      externalRef: 'PLATFORM-JE-4',
      actor: APPROVER,
    });

    const actions = (await listAuditEvents(db, sellerId)).map((e) => e.action);
    expect(actions).toContain('external_sync.confirmed');
  });

  it('distinguishes local posting success from external confirmation in the tool output', async () => {
    const { db, sellerId } = await makeTestDb({ authoritativeSystem: 'external' });

    const proposed = await callTool(db, AGENT, 'propose_ledger_update', {
      operation: {
        kind: 'record_payment',
        seller_id: sellerId,
        amount_cents: 5000,
        received_at: '2026-09-01T12:00:00.000Z',
      },
    });
    const proposalId = (proposed.result as { proposal_id: string }).proposal_id;
    await callTool(db, APPROVER, 'approve_ledger_update', { proposal_id: proposalId });
    const posted = await callTool(db, AGENT, 'post_ledger_update', {
      proposal_id: proposalId,
    });

    const result = posted.result as { external_sync_state: string; external_note: string };
    expect(result.external_sync_state).toBe('pending');
    expect(result.external_note).toMatch(/awaiting confirmation/);
    expect(result.external_note).not.toMatch(/updated/i);
  });
});
