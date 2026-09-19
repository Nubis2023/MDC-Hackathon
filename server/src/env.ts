/**
 * Environment loading.
 *
 * The server previously read configuration straight from `process.env` and
 * nothing ever loaded a `.env` file, so a developer had to export
 * SUPABASE_DB_URL in every new shell. This loads one from the repo root at
 * startup, using Node's built-in `process.loadEnvFile` (Node 20.6+) rather
 * than adding a dotenv dependency.
 *
 * Real environment variables always win: `loadEnvFile` does not overwrite what
 * is already set, which is what you want in CI and on a host that injects
 * config. A missing `.env` is not an error — it is the normal case in
 * production, and in a fresh clone before you copy `.env.example`.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Candidate `.env` locations: repo root, then the server package. */
function candidatePaths(): string[] {
  // __dirname is server/src at dev time and server/dist when built, so this
  // resolves to the repo root in both cases.
  const serverRoot = resolve(__dirname, '..');
  const repoRoot = resolve(serverRoot, '..');
  return [
    join(repoRoot, '.env'),
    join(repoRoot, '.env.local'),
    join(serverRoot, '.env'),
    join(serverRoot, '.env.local'),
  ];
}

export interface LoadEnvResult {
  loaded: string[];
  skipped: string[];
}

/**
 * Load `.env` files if present. Idempotent and safe to call from multiple
 * entry points (the server and the seed script both do).
 */
export function loadEnv(): LoadEnvResult {
  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const path of candidatePaths()) {
    if (!existsSync(path)) {
      skipped.push(path);
      continue;
    }
    try {
      // Does not overwrite variables that are already set in the environment.
      process.loadEnvFile(path);
      loaded.push(path);
    } catch {
      // A malformed .env must not stop the process: the app can still run on
      // real environment variables, and failing here would be a confusing
      // start-up error. The caller logs which files loaded.
      skipped.push(path);
    }
  }

  return { loaded, skipped };
}

/**
 * Report which backend the current environment selects, with any password
 * masked. Called at startup so it is obvious which database the process is
 * talking to — the difference between a local run and one against Supabase is
 * otherwise invisible.
 */
export function describeTarget(): string {
  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    return `postgres ${url.replace(/:[^:@/]*@/, ':***@')}`;
  }
  return `sqlite ${process.env.DB_FILE ?? join(resolve(__dirname, '..'), 'data', 'ledger.db')}`;
}

/** Guard against the publishable/anon key being used as a connection string. */
export function validateTarget(): string | null {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return null;
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return (
      'SUPABASE_DB_URL must be a Postgres connection string ' +
      '(postgresql://…). It is not the anon/publishable key, and not the ' +
      'REST URL. Use the direct connection from Project Settings → Database.'
    );
  }
  return null;
}

/** Exported for tests. */
export const __internals = { candidatePaths, dirname };
