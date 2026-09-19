-- Supabase seed: reference and configuration data only.
--
-- Deliberately does NOT insert journal entries, payments or allocations.
-- Those are produced by the posting pipeline, which derives entry numbers,
-- enforces the balance trigger, writes audit events and suppresses reminders.
-- Hand-writing them here would duplicate that logic and could produce a
-- ledger that violates the invariants the schema enforces.
--
-- What this seeds is the configuration the pipeline reads: sellers, users,
-- memberships, the chart of accounts and the account mappings. Run it, then
-- drive the transactional workflow through the API or the UI.
--
-- Idempotent: safe to re-run.

-- ─────────────────────────────── sellers ───────────────────────────────

insert into sellers (id, name, currency, authoritative_system) values
  ('seller_northwind', 'Northwind Trading Co.', 'USD', 'local'),
  ('seller_acme',      'Acme Fabrication LLC',  'USD', 'external')
on conflict (id) do nothing;

-- ──────────────────────────────── users ────────────────────────────────
-- auth_user_id is left null here: it is populated when a Supabase identity
-- is linked to a ledger user. A user with no auth_user_id simply cannot
-- authenticate, which is the correct default for seeded reference users.
-- Link them with:
--   update users set auth_user_id = '<uuid from auth.users>' where id = '<user id>';

insert into users (id, name, kind) values
  ('user_owner_1',      'Dana Owner',            'human'),
  ('user_approver_1',   'Priya Approver',        'human'),
  ('user_bookkeeper_1', 'Sam Bookkeeper',        'human'),
  ('user_owner_2',      'Alex Owner (Acme)',     'human'),
  ('agent_recon_1',     'Reconciliation Agent',  'agent')
on conflict (id) do nothing;

-- ───────────────────────────── memberships ─────────────────────────────
-- seller_acme intentionally has no membership for the Northwind users, so the
-- cross-tenant refusal is exercisable out of the box.
insert into seller_memberships (seller_id, user_id, role) values
  ('seller_northwind', 'user_owner_1',      'owner'),
  ('seller_northwind', 'user_approver_1',   'approver'),
  ('seller_northwind', 'user_bookkeeper_1', 'bookkeeper'),
  ('seller_northwind', 'agent_recon_1',     'bookkeeper'),
  ('seller_acme',      'user_owner_2',      'owner'),
  ('seller_acme',      'agent_recon_1',     'bookkeeper')
on conflict (seller_id, user_id) do nothing;

-- ─────────────────────── chart of accounts, per seller ─────────────────
-- Account ids are namespaced per seller so the composite primary key is
-- unique and a mapping cannot point at another seller's account.
--
-- Scoped to the sellers this seed owns, and using a bare ON CONFLICT DO
-- NOTHING so a re-run (or a project where these codes already exist under
-- different ids) cannot fail on the unique(seller_id, code) constraint.

do $$
declare
  s text;
  acct record;
begin
  for s in
    select id from sellers where id in ('seller_northwind', 'seller_acme')
  loop
    for acct in
      select * from (values
        ('cash',         '1000', 'Cash at Bank',              'asset'),
        ('unapplied',    '1010', 'Unapplied Customer Cash',   'liability'),
        ('ar',           '1100', 'Accounts Receivable',       'asset'),
        ('tax',          '2200', 'Sales Tax Payable',         'liability'),
        ('revenue',      '4000', 'Sales Revenue',             'revenue'),
        ('credit_note',  '4100', 'Sales Returns and Credits', 'revenue'),
        ('fee',          '6100', 'Payment Processing Fees',   'expense'),
        ('refund',       '6200', 'Customer Refunds',          'expense'),
        ('adjustment',   '6300', 'Ledger Adjustments',        'expense')
      ) as t(suffix, code, name, type)
    loop
      insert into gl_accounts (id, seller_id, code, name, type)
      values (s || '__' || acct.suffix, s, acct.code, acct.name, acct.type::text)
      on conflict do nothing;
    end loop;
  end loop;
end;
$$;

-- ────────────────────────── account mappings ───────────────────────────
-- Both sides for every key, so any operation the service can plan resolves
-- to a configured account rather than failing at post time.

do $$
declare
  s text;
  m record;
begin
  for s in
    select id from sellers where id in ('seller_northwind', 'seller_acme')
  loop
    for m in
      select * from (values
        ('cash'), ('unapplied_cash'), ('accounts_receivable'), ('revenue'),
        ('tax_payable'), ('credit_note'), ('fee_expense'), ('refund_expense'),
        ('adjustment')
      ) as t(mapping_key)
    loop
      -- The account a mapping key resolves to.
      insert into account_mappings (seller_id, mapping_key, side, account_id)
      select s, m.mapping_key, 'debit',
             s || '__' || case m.mapping_key
               when 'cash'                then 'cash'
               when 'unapplied_cash'      then 'unapplied'
               when 'accounts_receivable' then 'ar'
               when 'revenue'             then 'revenue'
               when 'tax_payable'         then 'tax'
               when 'credit_note'         then 'credit_note'
               when 'fee_expense'         then 'fee'
               when 'refund_expense'      then 'refund'
               when 'adjustment'          then 'adjustment'
             end
      on conflict do nothing;

      insert into account_mappings (seller_id, mapping_key, side, account_id)
      select s, m.mapping_key, 'credit',
             s || '__' || case m.mapping_key
               when 'cash'                then 'cash'
               when 'unapplied_cash'      then 'unapplied'
               when 'accounts_receivable' then 'ar'
               when 'revenue'             then 'revenue'
               when 'tax_payable'         then 'tax'
               when 'credit_note'         then 'credit_note'
               when 'fee_expense'         then 'fee'
               when 'refund_expense'      then 'refund'
               when 'adjustment'          then 'adjustment'
             end
      on conflict do nothing;
    end loop;
  end loop;
end;
$$;

-- ───────────────────────── auto-post rule (disabled) ───────────────────
-- Ships disabled so the default posture — approval required — is what a
-- fresh database demonstrates. `enabled` is integer (0/1), kept numeric so
-- SQLite and Postgres agree on the representation.
insert into auto_post_rules
  (id, seller_id, name, enabled, proposal_kind, match_mode, match_json, max_amount_cents, created_by)
values
  ('rule_nw_fees', 'seller_northwind', 'Auto-post processing fees up to $50',
   0, 'record_fee', 'exact', '{"description":"Card processing fee"}'::jsonb, 5000, 'user_owner_1')
on conflict (id) do nothing;

-- ─────────────────────────────── sanity check ──────────────────────────
-- Scoped to the sellers this seed owns. Asserting across all sellers would
-- fail on any seller created elsewhere (another seed, a migration, or the
-- application itself), which is not this file's business.
do $$
declare
  seeded text[] := array['seller_northwind', 'seller_acme'];
  missing_mappings int;
  missing_accounts int;
begin
  select count(*) into missing_mappings
    from unnest(seeded) as sid
   where not exists (select 1 from account_mappings m where m.seller_id = sid);

  if missing_mappings > 0 then
    raise exception
      'seed incomplete: % seeded seller(s) have no account mappings', missing_mappings;
  end if;

  select count(*) into missing_accounts
    from unnest(seeded) as sid
   where not exists (select 1 from gl_accounts a where a.seller_id = sid);

  if missing_accounts > 0 then
    raise exception
      'seed incomplete: % seeded seller(s) have no chart of accounts', missing_accounts;
  end if;

  raise notice 'seed ok: % sellers, % accounts, % mappings',
    (select count(*) from sellers where id = any (seeded)),
    (select count(*) from gl_accounts where seller_id = any (seeded)),
    (select count(*) from account_mappings where seller_id = any (seeded));
end;
$$;
