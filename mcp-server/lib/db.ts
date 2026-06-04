import postgres from 'postgres';

/**
 * Postgres connection (porsager/postgres).
 *
 * Configured for Supabase Transaction Pooler (port 6543):
 *   - prepare: false   — required; transaction-mode poolers don't preserve prepared statements
 *   - max: 1           — minimize connections per serverless instance; rely on pooler
 *   - idle_timeout: 20 — release idle connections quickly
 *
 * Singleton across hot reloads in development; per-invocation in production serverless.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
      'Use the Supabase Transaction Pooler connection string (port 6543).'
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__sql ??
  postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__sql = sql;
}
