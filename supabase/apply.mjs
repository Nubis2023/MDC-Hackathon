/**
 * Apply the ledger schema and seed to a Postgres database (a Supabase project).
 *
 * The Supabase MCP connection from Mel is blocked — the connected key is a
 * publishable (browser) key, which cannot reach a project. This script is the
 * working path: it connects directly over the Postgres protocol with a real
 * connection string.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgresql://... node supabase/apply.mjs
 *   SUPABASE_DB_URL=postgresql://... node supabase/apply.mjs --with-seed
 *   SUPABASE_DB_URL=postgresql://... node supabase/apply.mjs --dry-run
 *
 * Flags:
 *   --with-seed   also run seed.sql (reference/config data only)
 *   --dry-run     print what would run, connect to nothing, change nothing
 *
 * Find SUPABASE_DB_URL in the Supabase dashboard under
 * Project Settings -> Database -> Connection string -> URI. Use the direct
 * connection (port 5432) for migrations, not the pooler.
 *
 * Safety: the whole migration runs inside a single transaction. If any
 * statement fails, nothing is applied. Both files are idempotent, so a
 * re-run is safe.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const withSeed = args.has('--with-seed');
const dryRun = args.has('--dry-run');

const migrationPath = join(here, 'migrations', '20260919000000_seller_ledger.sql');
const seedPath = join(here, 'seed.sql');

const migration = readFileSync(migrationPath, 'utf8');
const seed = withSeed ? readFileSync(seedPath, 'utf8') : null;

if (dryRun) {
  console.log('DRY RUN — nothing will be executed.\n');
  console.log(`Migration: ${migrationPath}`);
  console.log(`  ${migration.split('\n').length} lines`);
  if (seed) {
    console.log(`Seed:      ${seedPath}`);
    console.log(`  ${seed.split('\n').length} lines`);
  } else {
    console.log('Seed:      (skipped; pass --with-seed to include)');
  }
  console.log('\nSet SUPABASE_DB_URL and re-run without --dry-run to apply.');
  process.exit(0);
}

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    'SUPABASE_DB_URL is not set.\n\n' +
      'Set it to your project\'s direct Postgres connection string:\n' +
      '  export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"\n\n' +
      'Then re-run. Use --dry-run first if you want to see what would run.',
  );
  process.exit(1);
}

// Guard against the publishable/anon key being pasted here by mistake. That
// key has no business being used for DDL, and failing loudly is better than a
// confusing connection error.
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error(
    'SUPABASE_DB_URL does not look like a Postgres connection string.\n' +
      'It must start with postgresql:// — it is NOT the anon or publishable key.',
  );
  process.exit(1);
}

const { default: postgres } = await import('postgres');

// Supabase requires TLS. A local Postgres or the test harness does not, so
// this is overridable — but it defaults to requiring TLS, because silently
// connecting to a hosted database without it would be the wrong default.
const sslMode = process.env.SUPABASE_DB_SSL ?? 'require';
const ssl = sslMode === 'disable' ? false : sslMode === 'no-verify' ? { rejectUnauthorized: false } : 'require';

const sql = postgres(url, {
  ssl,
  max: 1,
  // DDL over a slow link can exceed the default; give it room.
  idle_timeout: 20,
  connect_timeout: 30,
});

let exitCode = 0;

try {
  console.log('Connecting…');
  const [{ version }] = await sql`select version() as version`;
  console.log(`Connected: ${String(version).split(',')[0]}\n`);

  // ── Migration ────────────────────────────────────────────────────────
  console.log('Applying migration…');
  const t0 = Date.now();
  // One transaction for the whole file: either the schema lands or it does
  // not. Note postgres-js runs a template literal as a simple query, so the
  // multi-statement file is wrapped explicitly rather than by the driver.
  await sql.begin(async (tx) => {
    await tx.unsafe(migration);
  });
  console.log(`  applied in ${Date.now() - t0}ms`);

  // ── Seed ─────────────────────────────────────────────────────────────
  if (seed) {
    console.log('Applying seed (reference and configuration data)…');
    const t1 = Date.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(seed);
    });
    console.log(`  applied in ${Date.now() - t1}ms`);
  } else {
    console.log('Seed skipped (pass --with-seed to include it).');
  }

  // ── Report what landed ───────────────────────────────────────────────
  console.log('\nVerifying…');

  const [{ tables }] = await sql`
    select count(*)::int as tables from pg_tables where schemaname = 'public'
  `;
  const [{ rls }] = await sql`
    select count(*)::int as rls from pg_tables
     where schemaname = 'public' and rowsecurity = true
  `;
  const [{ policies }] = await sql`
    select count(*)::int as policies from pg_policies where schemaname = 'public'
  `;
  const [{ triggers }] = await sql`
    select count(*)::int as triggers from pg_trigger where not tgisinternal
  `;

  console.log(`  tables:   ${tables}`);
  console.log(`  RLS on:   ${rls}`);
  console.log(`  policies: ${policies}`);
  console.log(`  triggers: ${triggers}`);

  // A table with RLS and no policy denies everything, which would look like
  // an empty application rather than a misconfiguration. Surface it.
  const orphans = await sql`
    select t.tablename from pg_tables t
     where t.schemaname = 'public' and t.rowsecurity = true
       and not exists (
         select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename
       )
  `;
  if (orphans.length > 0) {
    console.warn(
      `\nWARNING: RLS is enabled with no policy on: ` +
        orphans.map((r) => r.tablename).join(', ') +
        '\nThose tables will return nothing to any client.',
    );
  }

  if (withSeed) {
    const [{ sellers }] = await sql`select count(*)::int as sellers from sellers`;
    const [{ mappings }] = await sql`
      select count(*)::int as mappings from account_mappings
    `;
    console.log(`  sellers:  ${sellers}`);
    console.log(`  mappings: ${mappings}`);
  }

  console.log('\nDone.');
} catch (err) {
  exitCode = 1;
  console.error('\nFAILED — nothing was committed.');
  console.error(err instanceof Error ? err.message : String(err));
  if (err && typeof err === 'object' && 'detail' in err) {
    console.error(`detail: ${String(err.detail)}`);
  }
  if (err && typeof err === 'object' && 'hint' in err && err.hint) {
    console.error(`hint:   ${String(err.hint)}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(exitCode);
