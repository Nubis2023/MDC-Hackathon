/**
 * End-to-end test of supabase/apply.mjs.
 *
 * apply.mjs talks to Postgres over the wire protocol. To test it for real —
 * rather than mock the driver — this starts a PGlite instance behind
 * PGLiteSocketServer, which speaks the actual Postgres protocol on a TCP
 * port, then runs apply.mjs against it as a subprocess.
 *
 * That exercises the whole path: connection string parsing, the transaction
 * wrapper, multi-statement DDL, the seed, and the post-apply report.
 *
 * Run: node supabase/test-apply.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const PORT = 55432;

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed++;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
}

/** Run apply.mjs as a subprocess and capture its output. */
function runApply(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(here, 'apply.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

console.log('\napply.mjs end-to-end test (real Postgres wire protocol)');
console.log('======================================================\n');

const db = new PGlite();

// The migration references auth.users and auth.uid(), which Supabase provides,
// and revokes/grant EXECUTE on the anon + authenticated roles it creates.
// Stub all of it so the schema can apply against bare Postgres.
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
  );
  create or replace function auth.uid()
  returns uuid language sql stable
  as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end
  $$;
`);

const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await server.start();
console.log(`PGlite listening on the Postgres protocol at 127.0.0.1:${PORT}\n`);

const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

try {
  // ── Happy path: schema only ──────────────────────────────────────────
  console.log('Schema only');
  const r1 = await runApply({ SUPABASE_DB_URL: url, SUPABASE_DB_SSL: 'disable' });
  if (r1.code === 0) {
    ok('apply.mjs exits 0');
  } else {
    fail('apply.mjs exits 0', `${r1.err || r1.out}`.slice(0, 400));
  }

  if (/tables:\s+19/.test(r1.out)) {
    ok('reports 19 tables');
  } else {
    fail('reports 19 tables', r1.out.split('\n').filter((l) => l.includes('tables')).join(' '));
  }

  if (/triggers:\s+5/.test(r1.out)) {
    ok('reports 5 triggers');
  } else {
    fail('reports 5 triggers', r1.out.split('\n').filter((l) => l.includes('triggers')).join(' '));
  }

  if (/policies:\s+\d+/.test(r1.out)) {
    const n = Number(r1.out.match(/policies:\s+(\d+)/)[1]);
    if (n > 0) ok(`reports ${n} RLS policies`);
    else fail('reports RLS policies', 'zero policies');
  } else {
    fail('reports RLS policies', 'no policies line');
  }

  // The schema must actually be there, not merely reported.
  const t = await db.query(`select count(*)::int as n from pg_tables where schemaname='public'`);
  if (t.rows[0].n === 19) ok('schema really landed (19 tables in the database)');
  else fail('schema really landed', `${t.rows[0].n} tables`);

  // No seed, so no sellers yet.
  const s0 = await db.query(`select count(*)::int as n from sellers`);
  if (s0.rows[0].n === 0) ok('seed correctly skipped without --with-seed');
  else fail('seed correctly skipped', `${s0.rows[0].n} sellers present`);

  // ── With the seed ────────────────────────────────────────────────────
  console.log('\nSchema + seed');
  const r3 = await runApply(
    { SUPABASE_DB_URL: url, SUPABASE_DB_SSL: 'disable' },
    ['--with-seed'],
  );

  if (r3.code === 0) ok('apply.mjs --with-seed exits 0');
  else fail('apply.mjs --with-seed exits 0', `${r3.err || r3.out}`.slice(0, 400));

  const s1 = await db.query(`select count(*)::int as n from sellers`);
  if (s1.rows[0].n === 2) ok('seed created 2 sellers');
  else fail('seed created 2 sellers', `${s1.rows[0].n}`);

  const m1 = await db.query(`
    select count(*)::int as n from account_mappings
  `);
  if (m1.rows[0].n === 36) ok('seed created 36 account mappings');
  else fail('seed created 36 account mappings', `${m1.rows[0].n}`);

  // Every mapping must resolve, or the entry builder breaks at post time.
  const bad = await db.query(`
    select m.mapping_key from account_mappings m
     left join gl_accounts a on a.seller_id = m.seller_id and a.id = m.account_id
     where a.id is null
  `);
  if (bad.rows.length === 0) ok('every mapping resolves to an account');
  else fail('every mapping resolves', JSON.stringify(bad.rows.slice(0, 5)));

  // ── Idempotency through the real apply path ──────────────────────────
  console.log('\nIdempotency (re-running through apply.mjs)');
  const r4 = await runApply(
    { SUPABASE_DB_URL: url, SUPABASE_DB_SSL: 'disable' },
    ['--with-seed'],
  );

  if (r4.code === 0) ok('second --with-seed run exits 0');
  else fail('second --with-seed run exits 0', `${r4.err || r4.out}`.slice(0, 400));

  const s2 = await db.query(`select count(*)::int as n from sellers`);
  const m2 = await db.query(`select count(*)::int as n from account_mappings`);
  if (s2.rows[0].n === 2 && m2.rows[0].n === 36) {
    ok('re-run added no duplicate rows', `${s2.rows[0].n} sellers, ${m2.rows[0].n} mappings`);
  } else {
    fail('re-run added no duplicate rows', `${s2.rows[0].n} sellers, ${m2.rows[0].n} mappings`);
  }

  const dupTrig = await db.query(`
    select tgname from pg_trigger where not tgisinternal
     group by tgname having count(*) > 1
  `);
  if (dupTrig.rows.length === 0) ok('re-run duplicated no triggers');
  else fail('re-run duplicated no triggers', JSON.stringify(dupTrig.rows));

  // ── The invariants must still hold on the applied database ───────────
  console.log('\nInvariants on the applied database');

  // Unbalanced entry refused.
  await db.exec(`
    insert into journal_entries
      (id, seller_id, entry_no, entry_date, memo, source_type, source_id,
       source_event_id, entry_kind, status)
    values ('e1','seller_northwind',1,'2026-09-01','x','t','s','ev1','standard','pending');
    insert into journal_lines (id, seller_id, entry_id, line_no, account_id, amount_cents)
    values ('l1','seller_northwind','e1',1,'seller_northwind__cash',500);
  `);
  let rejected = false;
  try {
    await db.exec(`update journal_entries set status='posted', posted_at=now() where id='e1'`);
  } catch {
    rejected = true;
  }
  if (rejected) ok('unbalanced entry refused after apply');
  else fail('unbalanced entry refused after apply', 'it was accepted');

  // RLS present on the applied database.
  const rls = await db.query(`
    select count(*)::int as n from pg_tables
     where schemaname='public' and rowsecurity = true
  `);
  if (rls.rows[0].n === 19) ok('RLS enabled on all 19 tables after apply');
  else fail('RLS enabled on all 19 tables', `${rls.rows[0].n}`);

  // ── Failure path: a bad connection string must not half-apply ────────
  console.log('\nFailure handling');
  const badUrl = await runApply({
    SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:1/postgres',
    SUPABASE_DB_SSL: 'disable',
  });
  if (badUrl.code !== 0) ok('unreachable database exits non-zero');
  else fail('unreachable database exits non-zero', 'it exited 0');

  if (/nothing was committed/i.test(badUrl.err)) {
    ok('reports that nothing was committed');
  } else {
    fail('reports that nothing was committed', badUrl.err.slice(0, 200));
  }
} finally {
  await server.stop();
  await db.close();
}

console.log('\n======================================================');
console.log(`${passed} passed, ${failed} failed`);
console.log('======================================================\n');

process.exit(failed === 0 ? 0 : 1);
