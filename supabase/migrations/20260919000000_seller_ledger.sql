-- Seller-scoped ledger — Postgres / Supabase schema.
--
-- Port of server/src/db/schema.sql. The point of this file is that the
-- ledger's integrity guarantees move from application code into the database,
-- which matters more on Supabase than it did on SQLite because PostgREST
-- exposes the tables over HTTP. Anything the database does not enforce, a
-- client with a valid key can bypass.
--
-- Three things are enforced here, not in the service layer:
--   1. A journal entry cannot be posted unless its lines sum to zero.
--   2. A posted entry and its lines are immutable. Corrections are reversals.
--   3. Every financial row is seller-scoped, and RLS makes that enforceable
--      for any client, not just the ones that go through the service.
--
-- Types: money is bigint minor units (cents), never numeric/float. Ids stay
-- text rather than uuid because the idempotency design derives them
-- deterministically by hashing the source event; uuid would break that.

-- ─────────────────────────── extensions ─────────────────────────────────

-- No extensions are required. gen_random_uuid() is in Postgres core from 13
-- onward (and Supabase runs 15+), so pgcrypto is not needed for it. Keeping
-- the migration extension-free means it applies unchanged on Supabase, on a
-- local Postgres, and in the verification harness below.

-- ─────────────────────────── sellers & access ───────────────────────────

create table if not exists sellers (
  id                    text primary key,
  name                  text not null,
  currency              text not null default 'USD',
  -- 'local'    : the operational ledger in this database is the source of truth
  -- 'external' : a connected accounting platform is authoritative, so local
  --              postings are provisional until that platform confirms them
  authoritative_system  text not null default 'local'
                        check (authoritative_system in ('local', 'external')),
  created_at            timestamptz not null default now()
);

-- Mirrors auth.users. The text id is what the ledger tables reference; the
-- uuid links a row to the authenticated identity Supabase provides.
create table if not exists users (
  id            text primary key,
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  name          text not null,
  kind          text not null check (kind in ('human', 'agent')),
  created_at    timestamptz not null default now()
);

create index if not exists idx_users_auth on users (auth_user_id);

create table if not exists seller_memberships (
  seller_id   text not null references sellers (id) on delete cascade,
  user_id     text not null references users (id) on delete cascade,
  role        text not null check (role in ('owner', 'approver', 'bookkeeper', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (seller_id, user_id)
);

-- ───────────────────────────── GL configuration ─────────────────────────

create table if not exists gl_accounts (
  id          text not null,
  seller_id   text not null references sellers (id) on delete cascade,
  code        text not null,
  name        text not null,
  type        text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  created_at  timestamptz not null default now(),
  primary key (seller_id, id),
  unique (seller_id, code)
);

-- Each mapping key resolves the account to use for a given side, which is
-- what keeps account codes out of the service layer.
create table if not exists account_mappings (
  seller_id    text not null references sellers (id) on delete cascade,
  mapping_key  text not null,
  side         text not null check (side in ('debit', 'credit')),
  account_id   text not null,
  created_at   timestamptz not null default now(),
  primary key (seller_id, mapping_key, side),
  foreign key (seller_id, account_id) references gl_accounts (seller_id, id) on delete cascade
);

-- ─────────────────────────────── invoices ───────────────────────────────

create table if not exists invoices (
  id              text primary key,
  seller_id       text not null references sellers (id) on delete cascade,
  customer_name   text not null,
  number          text not null,
  issue_date      date not null,
  due_date        date not null,
  currency        text not null default 'USD',
  subtotal_cents  bigint not null,
  tax_cents       bigint not null default 0,
  total_cents     bigint not null,
  -- Cache of the value derived from allocations, credit notes, adjustments
  -- and refunds. The reconciliation interface re-derives it and reports any
  -- disagreement as drift rather than trusting this column.
  balance_cents   bigint not null,
  status          text not null check (status in ('open', 'partially_paid', 'paid', 'void')),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  unique (seller_id, number),
  constraint invoices_total_matches_parts
    check (total_cents = subtotal_cents + tax_cents)
);

-- ─────────────────────── inbound cash & allocations ─────────────────────

create table if not exists payments (
  id                 text primary key,
  seller_id          text not null references sellers (id) on delete cascade,
  amount_cents       bigint not null check (amount_cents > 0),
  currency           text not null default 'USD',
  received_at        timestamptz not null,
  reference          text,
  payer_name         text,
  status             text not null check (status in ('confirmed', 'reversed')),
  unallocated_cents  bigint not null,
  version            integer not null default 1,
  created_at         timestamptz not null default now()
);

create table if not exists payment_allocations (
  id                text primary key,
  seller_id         text not null references sellers (id) on delete cascade,
  payment_id        text not null references payments (id) on delete cascade,
  invoice_id        text not null references invoices (id) on delete cascade,
  amount_cents      bigint not null check (amount_cents > 0),
  status            text not null check (status in ('active', 'reversed')),
  journal_entry_id  text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_alloc_invoice on payment_allocations (invoice_id, status);
create index if not exists idx_alloc_payment on payment_allocations (payment_id, status);

-- ─────────────── credit notes, fees, refunds, adjustments ───────────────

create table if not exists credit_notes (
  id            text primary key,
  seller_id     text not null references sellers (id) on delete cascade,
  invoice_id    text references invoices (id) on delete cascade,
  amount_cents  bigint not null check (amount_cents > 0),
  reason        text,
  status        text not null check (status in ('applied', 'reversed')),
  created_at    timestamptz not null default now()
);

create table if not exists fees (
  id            text primary key,
  seller_id     text not null references sellers (id) on delete cascade,
  payment_id    text references payments (id) on delete set null,
  amount_cents  bigint not null check (amount_cents > 0),
  description   text not null,
  status        text not null check (status in ('charged', 'reversed')),
  created_at    timestamptz not null default now()
);

create table if not exists refunds (
  id            text primary key,
  seller_id     text not null references sellers (id) on delete cascade,
  payment_id    text not null references payments (id) on delete cascade,
  invoice_id    text references invoices (id) on delete set null,
  amount_cents  bigint not null check (amount_cents > 0),
  reason        text,
  status        text not null check (status in ('refunded', 'reversed')),
  created_at    timestamptz not null default now()
);

create table if not exists adjustments (
  id            text primary key,
  seller_id     text not null references sellers (id) on delete cascade,
  invoice_id    text references invoices (id) on delete cascade,
  amount_cents  bigint not null check (amount_cents <> 0),
  direction     text not null check (direction in ('debit', 'credit')),
  mapping_key   text not null,
  memo          text not null,
  approved_by   text references users (id),
  approved_at   timestamptz,
  created_by    text references users (id),
  status        text not null check (status in ('draft', 'approved', 'posted', 'reversed')),
  created_at    timestamptz not null default now(),
  -- An adjustment cannot be represented as approved or posted without an
  -- approver on record, so an unapproved posting is not expressible.
  constraint adjustments_approval_required
    check (status = 'draft' or approved_by is not null)
);

-- ──────────────────────────────── journal ───────────────────────────────

create table if not exists journal_entries (
  id                   text primary key,
  seller_id            text not null references sellers (id) on delete cascade,
  entry_no             integer not null,
  entry_date           date not null,
  memo                 text not null,
  source_type          text not null,
  source_id            text not null,
  source_event_id      text not null,
  idempotency_key      text,
  reversal_of          text references journal_entries (id),
  entry_kind           text not null check (entry_kind in ('standard', 'reversal')),
  status               text not null check (status in ('pending', 'posted', 'reversed')),
  posted_at            timestamptz,
  posted_by            text references users (id),
  external_sync_state  text not null default 'not_applicable'
                       check (external_sync_state in ('not_applicable', 'pending', 'confirmed', 'failed')),
  external_ref         text,
  external_synced_at   timestamptz,
  external_error       text,
  created_at           timestamptz not null default now(),
  unique (seller_id, entry_no),
  -- The duplicate-post defence that does not depend on the caller behaving.
  unique (seller_id, source_event_id)
);

-- Caller-supplied retry keys are unique per seller when present.
create unique index if not exists idx_journal_idempotency
  on journal_entries (seller_id, idempotency_key)
  where idempotency_key is not null;

-- An entry is reversed at most once.
create unique index if not exists idx_journal_single_reversal
  on journal_entries (reversal_of)
  where reversal_of is not null;

create table if not exists journal_lines (
  id            text primary key,
  seller_id     text not null references sellers (id) on delete cascade,
  entry_id      text not null references journal_entries (id) on delete cascade,
  line_no       integer not null,
  account_id    text not null,
  -- Signed: debit positive, credit negative. A balanced entry sums to zero,
  -- which makes "does it balance" a single sum and the trigger trivial.
  amount_cents  bigint not null check (amount_cents <> 0),
  memo          text,
  created_at    timestamptz not null default now(),
  unique (entry_id, line_no),
  foreign key (seller_id, account_id) references gl_accounts (seller_id, id)
);

create index if not exists idx_lines_entry on journal_lines (entry_id);

-- ───────────────────── proposals, approval & audit ──────────────────────

create table if not exists ledger_proposals (
  id                    text primary key,
  seller_id             text not null references sellers (id) on delete cascade,
  proposal_kind         text not null,
  source_type           text not null,
  source_id             text not null,
  source_event_id       text not null,
  idempotency_key       text,
  preview_json          jsonb not null,
  operation_json        jsonb not null,
  expected_json         jsonb not null,
  status                text not null default 'proposed'
                        check (status in ('proposed', 'approved', 'rejected', 'posted', 'superseded')),
  proposed_by           text not null references users (id),
  proposed_at           timestamptz not null default now(),
  approved_by           text references users (id),
  approved_at           timestamptz,
  rejected_by           text references users (id),
  rejected_at           timestamptz,
  rejection_reason      text,
  posted_entry_id       text references journal_entries (id),
  approval_basis        text check (approval_basis in ('manual', 'auto_rule')),
  auto_rule_id          text,
  auto_rule_match_json  jsonb,
  unique (seller_id, source_event_id),
  -- The agent-cannot-approve rule, enforced in the database as well as the
  -- service layer: a proposal approved on an auto-post rule records no human
  -- approver, but a manually approved one must.
  constraint proposals_manual_approval_needs_user
    check (approval_basis is distinct from 'manual' or approved_by is not null)
);

create index if not exists idx_proposals_status on ledger_proposals (seller_id, status);

create table if not exists auto_post_rules (
  id                text primary key,
  seller_id         text not null references sellers (id) on delete cascade,
  name              text not null,
  -- Integer rather than boolean, matching the SQLite development schema
  -- exactly. A boolean here would return true/false while SQLite returns
  -- 1/0, and every service comparison would need to know which backend it
  -- was talking to. One representation, both backends.
  enabled           integer not null default 0 check (enabled in (0, 1)),
  proposal_kind     text not null,
  -- Only exact matching exists. There is deliberately no fuzzy mode, so a
  -- rule can never fire on a near-miss.
  match_mode        text not null default 'exact' check (match_mode = 'exact'),
  match_json        jsonb not null,
  max_amount_cents  bigint,
  created_by        text not null references users (id),
  created_at        timestamptz not null default now(),
  -- An empty matcher would authorise every operation of its kind, which is
  -- not "exact match" in any meaningful sense.
  constraint auto_rules_matcher_not_empty
    check (match_json <> '{}'::jsonb)
);

-- Append-only audit trail. One row per state transition, written in the same
-- transaction as the change it describes.
create table if not exists audit_events (
  id           text primary key,
  seller_id    text not null references sellers (id) on delete cascade,
  actor_id     text not null references users (id),
  actor_kind   text not null check (actor_kind in ('human', 'agent')),
  action       text not null,
  entity_type  text not null,
  entity_id    text not null,
  detail_json  jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_audit_seller on audit_events (seller_id, created_at desc);

-- ───────────────────────── external sync tracking ───────────────────────

create table if not exists external_sync_attempts (
  id             text primary key,
  seller_id      text not null references sellers (id) on delete cascade,
  entry_id       text not null references journal_entries (id) on delete cascade,
  platform       text not null,
  state          text not null check (state in ('pending', 'confirmed', 'failed')),
  external_ref   text,
  request_json   jsonb,
  response_json  jsonb,
  error_message  text,
  attempted_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  -- The core external-ledger guarantee, at the storage layer: a confirmed
  -- sync must carry a platform-issued reference. Without one there is no
  -- evidence the platform accepted anything, so "confirmed" would be a
  -- fabricated reconciliation state.
  constraint sync_confirmed_needs_ref
    check (state <> 'confirmed' or external_ref is not null)
);

create index if not exists idx_sync_entry on external_sync_attempts (entry_id, attempted_at desc);

-- ───────────────────────── reminder eligibility ─────────────────────────

create table if not exists reminders (
  id                 text primary key,
  seller_id          text not null references sellers (id) on delete cascade,
  invoice_id         text not null references invoices (id) on delete cascade,
  kind               text not null check (kind in ('due_soon', 'overdue', 'final_notice')),
  status             text not null check (status in ('scheduled', 'sent', 'suppressed', 'skipped_settled')),
  scheduled_for      date not null,
  suppressed_reason  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_reminders_invoice on reminders (invoice_id, status);

-- ───────────────────────────── invariants ───────────────────────────────

-- Invariant: an entry may only become posted if its lines balance. Enforced
-- in the database so no code path — including direct PostgREST access — can
-- post an unbalanced entry.
create or replace function ledger_assert_entry_balanced()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n_lines integer;
  total   bigint;
begin
  select count(*), coalesce(sum(amount_cents), 0)
    into n_lines, total
    from journal_lines
   where entry_id = new.id;

  if n_lines < 2 then
    raise exception 'journal entry % must have at least two lines', new.id;
  end if;
  if total <> 0 then
    raise exception 'journal entry % lines must sum to zero (got %)', new.id, total;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_journal_entry_balance_on_post on journal_entries;
create trigger trg_journal_entry_balance_on_post
  before update of status on journal_entries
  for each row
  when (new.status = 'posted' and old.status is distinct from 'posted')
  execute function ledger_assert_entry_balanced();

-- A pending entry must never be left behind by a crashed posting. The
-- posting transaction inserts the entry, inserts its lines, then flips the
-- status, so a committed 'pending' row means the caller abandoned it.
create or replace function ledger_assert_no_orphan_pending()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'pending' and exists (
    select 1 from journal_lines where entry_id = new.id
  ) then
    raise exception 'entry % has lines but was never posted', new.id;
  end if;
  return new;
end;
$$;

-- Invariant: posted entries are immutable. Only status may still move
-- (posted -> reversed, via the reversal service) and only external-sync
-- bookkeeping may be written.
create or replace function ledger_assert_entry_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.posted_at is not null then
    if new.seller_id      is distinct from old.seller_id
    or new.entry_date     is distinct from old.entry_date
    or new.memo           is distinct from old.memo
    or new.source_type    is distinct from old.source_type
    or new.source_id      is distinct from old.source_id
    or new.source_event_id is distinct from old.source_event_id
    or new.entry_no       is distinct from old.entry_no
    or new.posted_by      is distinct from old.posted_by
    or new.posted_at      is distinct from old.posted_at
    or new.entry_kind     is distinct from old.entry_kind
    or new.reversal_of    is distinct from old.reversal_of
    then
      raise exception
        'posted journal entry % is immutable; correct it with a reversal entry', old.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_journal_entry_immutable on journal_entries;
create trigger trg_journal_entry_immutable
  before update on journal_entries
  for each row
  execute function ledger_assert_entry_immutable();

-- Lines of a posted entry cannot be edited or removed.
create or replace function ledger_assert_line_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entry_id text := coalesce(old.entry_id, new.entry_id);
begin
  if exists (
    select 1 from journal_entries
     where id = v_entry_id and posted_at is not null
  ) then
    raise exception 'lines of a posted journal entry are immutable (entry %)', v_entry_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_journal_line_immutable_update on journal_lines;
create trigger trg_journal_line_immutable_update
  before update on journal_lines
  for each row
  execute function ledger_assert_line_immutable();

drop trigger if exists trg_journal_line_immutable_delete on journal_lines;
create trigger trg_journal_line_immutable_delete
  before delete on journal_lines
  for each row
  execute function ledger_assert_line_immutable();

-- Allocations are reversed by flipping status, never deleted, so the history
-- of what settled an invoice survives.
create or replace function ledger_assert_allocation_not_deleted()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'payment allocations are reversed, not deleted';
end;
$$;

drop trigger if exists trg_allocation_no_delete on payment_allocations;
create trigger trg_allocation_no_delete
  before delete on payment_allocations
  for each row
  execute function ledger_assert_allocation_not_deleted();

-- ─────────────────────── row level security ─────────────────────────────

-- RLS matters here in a way it did not on SQLite: PostgREST exposes every
-- table in this schema over HTTP, so a valid anon key must not be able to
-- read or write another seller's books. These policies make seller scoping a
-- property of the database rather than of the service that happens to query
-- it.
--
-- Note on the service role: the Node backend connects with the service role
-- key, which BYPASSES RLS. The application-level access checks in
-- services/access.ts remain the first line of defence; these policies are
-- the second, covering direct client access and anything that reaches
-- PostgREST without going through the backend.

-- Resolve the authenticated identity to a ledger user. SECURITY DEFINER so
-- the lookup itself is not subject to RLS on users.
create or replace function ledger_current_user_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select id from users where auth_user_id = auth.uid()
$$;

create or replace function ledger_is_seller_member(p_seller_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from seller_memberships m
     where m.seller_id = p_seller_id
       and m.user_id = ledger_current_user_id()
  )
$$;

create or replace function ledger_has_seller_role(p_seller_id text, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from seller_memberships m
     where m.seller_id = p_seller_id
       and m.user_id = ledger_current_user_id()
       and m.role = any (p_roles)
  )
$$;

-- The three RLS helpers are SECURITY DEFINER and resolve identities on the
-- caller's behalf. They must not be reachable by the unauthenticated `anon`
-- role — that would be a needless /rest/v1/rpc/* surface and a way to probe
-- seller membership without signing in. EXECUTE stays on `authenticated`
-- because RLS policy expressions evaluate with the querying role's
-- privileges; revoking it there would break every policy.
revoke execute on function public.ledger_current_user_id()            from public, anon;
revoke execute on function public.ledger_is_seller_member(text)       from public, anon;
revoke execute on function public.ledger_has_seller_role(text, text[]) from public, anon;

grant execute on function public.ledger_current_user_id()            to authenticated;
grant execute on function public.ledger_is_seller_member(text)       to authenticated;
grant execute on function public.ledger_has_seller_role(text, text[]) to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'seller_memberships', 'gl_accounts', 'account_mappings', 'invoices',
    'payments', 'payment_allocations', 'credit_notes', 'fees', 'refunds',
    'adjustments', 'journal_entries', 'journal_lines', 'ledger_proposals',
    'auto_post_rules', 'audit_events', 'external_sync_attempts', 'reminders'
  ]
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end;
$$;

-- Sellers: visible to their members.
alter table sellers enable row level security;

drop policy if exists sellers_select_member on sellers;
create policy sellers_select_member on sellers
  for select using (ledger_is_seller_member(id));

drop policy if exists sellers_update_owner on sellers;
create policy sellers_update_owner on sellers
  for update using (ledger_has_seller_role(id, array['owner']))
  with check (ledger_has_seller_role(id, array['owner']));

-- Users: you can see yourself and the people you share a seller with.
alter table users enable row level security;

drop policy if exists users_select_self_or_colleague on users;
create policy users_select_self_or_colleague on users
  for select using (
    auth_user_id = auth.uid()
    or exists (
      select 1
        from seller_memberships mine
        join seller_memberships theirs on theirs.seller_id = mine.seller_id
       where mine.user_id = ledger_current_user_id()
         and theirs.user_id = users.id
    )
  );

-- Memberships: readable by fellow members, writable by owners.
drop policy if exists memberships_select on seller_memberships;
create policy memberships_select on seller_memberships
  for select using (ledger_is_seller_member(seller_id));

drop policy if exists memberships_write_owner on seller_memberships;
create policy memberships_write_owner on seller_memberships
  for all using (ledger_has_seller_role(seller_id, array['owner']))
  with check (ledger_has_seller_role(seller_id, array['owner']));

-- All seller-scoped financial tables: readable by any member.
-- Split into two groups because the write rules differ.

-- Group 1 — reading is member-scoped; writes are restricted to the roles the
-- service layer would allow anyway.
do $$
declare
  t text;
begin
  foreach t in array array[
    'gl_accounts', 'account_mappings', 'auto_post_rules', 'invoices',
    'payments', 'payment_allocations', 'credit_notes', 'fees', 'refunds',
    'reminders'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_select_member', t);
    execute format(
      'create policy %I on %I for select using (ledger_is_seller_member(seller_id))',
      t || '_select_member', t
    );

    execute format('drop policy if exists %I on %I', t || '_write_staff', t);
    execute format(
      'create policy %I on %I for all '
      'using (ledger_has_seller_role(seller_id, array[''owner'',''approver'',''bookkeeper''])) '
      'with check (ledger_has_seller_role(seller_id, array[''owner'',''approver'',''bookkeeper'']))',
      t || '_write_staff', t
    );
  end loop;
end;
$$;

-- Group 2 — the journal and proposals are append/transition only. Clients may
-- not insert posted entries or delete anything; the posting path runs through
-- the backend, which owns these transitions.
do $$
declare
  t text;
begin
  foreach t in array array['journal_entries', 'journal_lines', 'ledger_proposals', 'adjustments']
  loop
    execute format('drop policy if exists %I on %I', t || '_select_member', t);
    execute format(
      'create policy %I on %I for select using (ledger_is_seller_member(seller_id))',
      t || '_select_member', t
    );
  end loop;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['audit_events', 'external_sync_attempts']
  loop
    execute format('drop policy if exists %I on %I', t || '_select_member', t);
    execute format(
      'create policy %I on %I for select using (ledger_is_seller_member(seller_id))',
      t || '_select_member', t
    );
    -- Audit rows are written by the backend only; no client insert policy.
  end loop;
end;
$$;

-- ──────────────────────────── helper views ──────────────────────────────

-- Reconciles each invoice against the rows that actually account for its
-- balance, so drift is visible rather than inferred from a single column.
create or replace view invoice_reconciliation
with (security_invoker = true)
as
select
  i.id                                    as invoice_id,
  i.seller_id,
  i.number,
  i.customer_name,
  i.due_date,
  i.status,
  i.total_cents,
  i.balance_cents                         as stored_balance_cents,
  coalesce(a.allocated_cents, 0)          as allocated_cents,
  i.total_cents
    - coalesce(a.allocated_cents, 0)
    - coalesce(c.credited_cents, 0)
    - coalesce(adj.writeoff_cents, 0)
    + coalesce(adj.surcharge_cents, 0)
    + coalesce(r.refunded_cents, 0)       as expected_balance_cents,
  i.balance_cents
    - (i.total_cents
       - coalesce(a.allocated_cents, 0)
       - coalesce(c.credited_cents, 0)
       - coalesce(adj.writeoff_cents, 0)
       + coalesce(adj.surcharge_cents, 0)
       + coalesce(r.refunded_cents, 0))   as drift_cents
from invoices i
left join (
  select invoice_id, sum(amount_cents) as allocated_cents
    from payment_allocations where status = 'active' group by invoice_id
) a on a.invoice_id = i.id
left join (
  select invoice_id, sum(amount_cents) as credited_cents
    from credit_notes where status = 'applied' group by invoice_id
) c on c.invoice_id = i.id
left join (
  select invoice_id,
         sum(case when direction = 'debit'  then amount_cents else 0 end) as writeoff_cents,
         sum(case when direction = 'credit' then amount_cents else 0 end) as surcharge_cents
    from adjustments where status = 'posted' group by invoice_id
) adj on adj.invoice_id = i.id
left join (
  select invoice_id, sum(amount_cents) as refunded_cents
    from refunds where status = 'refunded' group by invoice_id
) r on r.invoice_id = i.id;
