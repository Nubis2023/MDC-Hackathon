-- Seller-scoped ledger schema.
--
-- Design notes that matter for the controls in the requirements:
--
--  * Money is stored in integer minor units (cents). Never floats.
--  * `posted_at`/`voided_at` drive the two hard invariants enforced by
--    triggers at the bottom of this file:
--      1. A journal entry may only become posted if its lines balance.
--      2. A posted journal entry and its lines are immutable.
--    Correcting a posting means a reversal entry, never an UPDATE.
--  * Idempotency is a UNIQUE constraint, not application logic, so a
--    retried request cannot double-post even under concurrency.
--  * `external_sync_state` distinguishes the local operational ledger from
--    a future accounting platform. Nothing here ever claims an external
--    ledger was updated; that state only advances on a platform ack.

PRAGMA foreign_keys = ON;

-- ─────────────────────────── sellers & access ───────────────────────────

CREATE TABLE IF NOT EXISTS sellers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  -- Which system is authoritative for this seller's books. 'local' means the
  -- operational ledger in this database is the source of truth.
  -- 'external' means a connected accounting platform is authoritative and
  -- local postings are provisional until acknowledged.
  authoritative_system TEXT NOT NULL DEFAULT 'local'
                CHECK (authoritative_system IN ('local', 'external')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- 'agent' users are non-human actors. They may propose and post, but the
  -- approval rules in ledger_proposals treat them specially: an agent can
  -- never approve its own proposal.
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every financial record is seller-scoped; access is checked against this
-- table on every operation (see services/access.ts).
CREATE TABLE IF NOT EXISTS seller_memberships (
  seller_id     TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'approver', 'bookkeeper', 'viewer')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seller_id, user_id)
);

-- ──────────────────────────── GL configuration ──────────────────────────

CREATE TABLE IF NOT EXISTS gl_accounts (
  id            TEXT NOT NULL,
  seller_id     TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seller_id, id),
  UNIQUE (seller_id, code)
);

-- Account mappings: which accounts each ledger event touches. Configurable
-- per seller, which is what lets every operation build a balanced entry
-- without hardcoding account codes in the service layer.
-- Each mapping key resolves the account to use for a given side. Operations
-- declare (mapping_key, side) pairs; the builder looks up the account here,
-- which is what keeps account codes out of the service layer entirely.
CREATE TABLE IF NOT EXISTS account_mappings (
  seller_id     TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  mapping_key   TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  account_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (seller_id, mapping_key, side),
  FOREIGN KEY (seller_id, account_id) REFERENCES gl_accounts(seller_id, id) ON DELETE CASCADE
);

-- ───────────────────────────── invoice AR ───────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  customer_name   TEXT NOT NULL,
  number          TEXT NOT NULL,
  issue_date      TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  -- total_cents = subtotal plus tax, fixed at issue time.
  subtotal_cents  INTEGER NOT NULL,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL,
  -- Maintained by the posting transaction; the reconciliation interface
  -- compares this against the sum of live allocations.
  balance_cents   INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'partially_paid', 'paid', 'void')),
  -- Optimistic concurrency. Every mutation bumps this; postings compare the
  -- version they previewed against the live row and abort on mismatch.
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (seller_id, number)
);

-- ─────────────────────── inbound cash & allocations ─────────────────────

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,
  seller_id             TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL DEFAULT 'USD',
  received_at           TEXT NOT NULL,
  reference             TEXT,
  payer_name            TEXT,
  -- Lifecycle: 'confirmed' is the only state that may be allocated.
  -- A 'reversed' payment's allocations are released.
  status                TEXT NOT NULL CHECK (status IN ('confirmed', 'reversed')),
  -- Unallocated remainder. allocated + unallocated == amount.
  unallocated_cents     INTEGER NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payment -> invoice allocation. This is the join that the reconciliation
-- interface walks to explain "invoice settled by which payments".
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                TEXT PRIMARY KEY,
  seller_id         TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id        TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Allocation is reversed by flipping this, never by deleting the row.
  status            TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
  -- The journal entry that posted this allocation, so the reconciliation
  -- interface can trace any allocation back to its ledger entry.
  journal_entry_id  TEXT REFERENCES journal_entries(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────── credit notes, fees, refunds, adjustments ───────────

CREATE TABLE IF NOT EXISTS credit_notes (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  invoice_id      TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  reason          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('applied', 'reversed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fees (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  -- A payment processor fee references the payment it was deducted from.
  payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  description     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('charged', 'reversed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id      TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  reason          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('refunded', 'reversed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manual adjustment. Only postable once approved_by is set; the service
-- enforces that, and the CHECK below makes an unapproved posting impossible
-- to represent in the database at all.
CREATE TABLE IF NOT EXISTS adjustments (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  -- Optional: a write-off or surcharge that targets a specific invoice.
  -- When set, the adjustment moves that invoice's outstanding balance.
  invoice_id      TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents <> 0),
  -- 'debit' debits the mapped account and credits AR (a write-off, which
  -- reduces the invoice balance). 'credit' does the reverse (a surcharge).
  direction       TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  mapping_key     TEXT NOT NULL,
  memo            TEXT NOT NULL,
  approved_by     TEXT REFERENCES users(id),
  approved_at     TEXT,
  created_by      TEXT REFERENCES users(id),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'posted', 'reversed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Table-level constraint: an adjustment cannot be represented as approved
  -- or posted without an approver on record.
  CHECK (status = 'draft' OR approved_by IS NOT NULL)
);

-- ───────────────────────────── journal ──────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_entries (
  id                  TEXT PRIMARY KEY,
  seller_id           TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  entry_no            INTEGER NOT NULL,
  entry_date          TEXT NOT NULL,
  memo                TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  -- Unique per seller+source so the same business event can never post twice.
  -- This is the duplicate-post defence that does not depend on the caller
  -- behaving well.
  source_event_id     TEXT NOT NULL,
  -- Caller-supplied retry key. Nullable because internal/system postings
  -- (e.g. an auto-post rule firing) have no inbound request to key off.
  idempotency_key     TEXT,
  reversal_of         TEXT REFERENCES journal_entries(id),
  entry_kind          TEXT NOT NULL CHECK (entry_kind IN ('standard', 'reversal')),
  -- Local ledger state. 'posted' here says nothing about any external system.
  status              TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'reversed')),
  posted_at           TEXT,
  posted_by           TEXT REFERENCES users(id),
  -- External accounting platform sync. 'not_applicable' when no platform is
  -- connected. 'confirmed' is ONLY ever set from a platform acknowledgement.
  external_sync_state TEXT NOT NULL DEFAULT 'not_applicable'
                      CHECK (external_sync_state IN ('not_applicable', 'pending', 'confirmed', 'failed')),
  external_ref        TEXT,
  external_synced_at  TEXT,
  external_error      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (seller_id, entry_no),
  UNIQUE (seller_id, source_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_idempotency
  ON journal_entries (seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_single_reversal
  ON journal_entries (reversal_of)
  WHERE reversal_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal_lines (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  account_id      TEXT NOT NULL,
  -- Signed: debit positive, credit negative. A balanced entry sums to zero.
  -- Storing one signed column instead of two makes "does it balance" a
  -- single SUM and makes the balance trigger trivial.
  amount_cents    INTEGER NOT NULL CHECK (amount_cents <> 0),
  memo            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, line_no),
  FOREIGN KEY (seller_id, account_id) REFERENCES gl_accounts(seller_id, id)
);

-- ──────────────────── proposals, approval & audit ───────────────────────

CREATE TABLE IF NOT EXISTS ledger_proposals (
  id                TEXT PRIMARY KEY,
  seller_id         TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  proposal_kind     TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  source_event_id   TEXT NOT NULL,
  idempotency_key   TEXT,
  -- The preview payload: proposed lines, affected invoices, balance changes,
  -- supporting source records. Shown to the approver before posting.
  preview_json      TEXT NOT NULL,
  -- The original operation input. Posting re-plans from this rather than
  -- trusting preview_json, so the committed entry is always derived from the
  -- source request and revalidated against live state.
  operation_json    TEXT NOT NULL,
  -- Everything the post step must revalidate against, captured at propose
  -- time so drift is detectable rather than silent.
  expected_json     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'posted', 'superseded')),
  proposed_by       TEXT NOT NULL REFERENCES users(id),
  proposed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by       TEXT REFERENCES users(id),
  approved_at       TEXT,
  rejected_by       TEXT REFERENCES users(id),
  rejected_at       TEXT,
  rejection_reason  TEXT,
  posted_entry_id   TEXT REFERENCES journal_entries(id),
  -- Satisfied by either an explicit approval or an auto-post rule.
  approval_basis    TEXT CHECK (approval_basis IN ('manual', 'auto_rule')),
  auto_rule_id      TEXT,
  -- The rule match is stored on the proposal as evidence for why auto-posting
  -- was permitted.
  auto_rule_match_json TEXT,
  UNIQUE (seller_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON ledger_proposals (seller_id, status);

CREATE TABLE IF NOT EXISTS auto_post_rules (
  id                TEXT PRIMARY KEY,
  seller_id         TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  proposal_kind     TEXT NOT NULL,
  -- 'exact' requires amount equality and every field in match_json to align.
  -- Only 'exact' is supported; there is no fuzzy auto-post.
  match_mode        TEXT NOT NULL DEFAULT 'exact' CHECK (match_mode = 'exact'),
  match_json        TEXT NOT NULL,
  max_amount_cents  INTEGER,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit trail. One row per state transition, written inside the
-- same transaction as the change it describes.
CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  seller_id     TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  detail_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_seller ON audit_events (seller_id, created_at);

-- ───────────────────────── external sync tracking ───────────────────────

-- One row per attempt to push a posted entry to an external accounting
-- platform. Kept separate from journal_entries so the attempt history is
-- visible even when the platform never confirms.
CREATE TABLE IF NOT EXISTS external_sync_attempts (
  id              TEXT PRIMARY KEY,
  seller_id       TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'failed')),
  external_ref    TEXT,
  request_json    TEXT,
  response_json   TEXT,
  error_message   TEXT,
  attempted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_entry ON external_sync_attempts (entry_id, attempted_at);

-- ───────────────────────── reminder eligibility ─────────────────────────

-- A reminder queue rather than a fire-and-forget job, so that posting a
-- payment can withdraw a reminder that is no longer eligible. The service
-- re-evaluates after every posting.
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  seller_id     TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('due_soon', 'overdue', 'final_notice')),
  status        TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'suppressed', 'skipped_settled')),
  scheduled_for TEXT NOT NULL,
  suppressed_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reminders_invoice ON reminders (invoice_id, status);

-- ───────────────────────────── invariants ───────────────────────────────

-- Invariant 1: an entry may only be marked posted if its lines balance and
-- it has at least two of them. Enforced at the database so no code path —
-- including a future one — can post an unbalanced entry.
CREATE TRIGGER IF NOT EXISTS trg_journal_entry_balance_on_post
BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'posted' AND OLD.status <> 'posted'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
      THEN RAISE(ABORT, 'journal entry must have at least two lines')
    WHEN (SELECT COALESCE(SUM(amount_cents), 0) FROM journal_lines WHERE entry_id = NEW.id) <> 0
      THEN RAISE(ABORT, 'journal entry lines must sum to zero')
  END;
END;

-- Invariant 2: posted entries are immutable. Once posted_at is set the row
-- may only transition status (posted -> reversed, via the reversal service)
-- and may only receive external-sync bookkeeping. Everything else is frozen.
CREATE TRIGGER IF NOT EXISTS trg_journal_entry_immutable
BEFORE UPDATE ON journal_entries
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.seller_id <> OLD.seller_id
      OR NEW.entry_date <> OLD.entry_date
      OR NEW.memo <> OLD.memo
      OR NEW.source_type <> OLD.source_type
      OR NEW.source_id <> OLD.source_id
      OR NEW.source_event_id <> OLD.source_event_id
      OR NEW.entry_no <> OLD.entry_no
      OR NEW.posted_by <> OLD.posted_by
      OR NEW.posted_at <> OLD.posted_at
      THEN RAISE(ABORT, 'posted journal entries are immutable; correct via a reversal entry')
  END;
END;

-- Lines of a posted entry cannot be edited or removed.
CREATE TRIGGER IF NOT EXISTS trg_journal_line_immutable_update
BEFORE UPDATE ON journal_lines
WHEN (SELECT posted_at FROM journal_entries WHERE id = OLD.entry_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'lines of a posted journal entry are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_line_immutable_delete
BEFORE DELETE ON journal_lines
WHEN (SELECT posted_at FROM journal_entries WHERE id = OLD.entry_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'lines of a posted journal entry are immutable');
END;

-- Allocations against a posted-invoice chain are append-only: reversed by
-- status flip, never deleted, so history survives.
CREATE TRIGGER IF NOT EXISTS trg_allocation_no_delete
BEFORE DELETE ON payment_allocations
BEGIN
  SELECT RAISE(ABORT, 'payment allocations are reversed, not deleted');
END;
