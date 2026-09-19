/**
 * Server entry point.
 *
 * Wrapped in an async main() rather than using top-level await: the server
 * builds as CommonJS, where top-level await is not available.
 */

import { createApp } from './api';
import { describeDatabase, ensureDbDirectory, openDatabaseFromEnv } from './db';
import { DEFAULT_DB_PATH } from './db';
import { loadEnv, validateTarget } from './env';

async function main(): Promise<void> {
  // Load .env before anything reads configuration. Real environment variables
  // take precedence, so CI and hosted environments are unaffected.
  const { loaded } = loadEnv();
  if (loaded.length > 0) {
    console.log(`loaded env from ${loaded.join(', ')}`);
  }

  // A publishable/anon key or REST URL pasted in as the connection string is a
  // common mistake, and it fails later with a confusing driver error. Catch it
  // here with a message that names the actual problem.
  const targetProblem = validateTarget();
  if (targetProblem) {
    console.error(targetProblem);
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.PORT ?? 4000);

  // Only the SQLite path needs a directory created; Postgres is remote.
  if (!process.env.SUPABASE_DB_URL) {
    ensureDbDirectory(process.env.DB_FILE ?? DEFAULT_DB_PATH);
  }

  const db = openDatabaseFromEnv();

  // Confirm the connection works before accepting traffic, so a bad
  // connection string fails at startup rather than on the first request.
  try {
    await db.get('SELECT 1 AS ok');
  } catch (err) {
    console.error(
      `could not reach the database: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const app = createApp(db);

  const server = app.listen(port, () => {
    console.log(`seller-ledger api listening on http://localhost:${port}`);
    console.log(`database: ${describeDatabase(db)}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`);
    server.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
