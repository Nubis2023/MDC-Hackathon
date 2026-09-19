import { defineConfig } from 'vitest/config';

/**
 * When targeting Postgres, test files run serially in a single fork.
 *
 * The SQLite suite gives each test file its own in-memory database, so files
 * can run in parallel safely. Postgres has one database shared by the whole
 * run: two files truncating tables concurrently would delete each other's
 * fixtures mid-test, and the failures would look like flaky assertions rather
 * than a harness problem. Serialising removes that whole class of noise.
 *
 * It is a little slower, and only applies on the Postgres path.
 */
const targetingPostgres = Boolean(process.env.TEST_POSTGRES_URL);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    ...(targetingPostgres
      ? {
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        }
      : {}),
  },
});
