import postgres from 'postgres';

/**
 * Postgres connection (porsager/postgres).
 *
 * Configured for Supabase Transaction Pooler (port 6543):
 *   - prepare: false   — required; transaction-mode poolers don't preserve prepared statements
 *   - max: 1           — minimize connections per serverless instance; rely on pooler
 *   - idle_timeout: 20 — release idle connections quickly
 *
 * LAZY INITIALISATION: the client is created on first use, not at module import.
 * `next build` imports route modules during the "collect page data" phase; an
 * eager module-scope throw on a missing DATABASE_URL fails the build even though
 * the variable is present at runtime. Deferring creation to the first query keeps
 * the build environment-free and surfaces a missing DATABASE_URL only when a query
 * actually runs. Cached on globalThis for connection reuse across warm invocations.
 */

type SqlClient = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __sql: SqlClient | undefined;
}

function getClient(): SqlClient {
  if (globalThis.__sql) return globalThis.__sql;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is required. ' +
        'Use the Supabase Transaction Pooler connection string (port 6543).'
    );
  }

  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

  globalThis.__sql = client;
  return client;
}

/**
 * Lazy proxy preserving the `sql`...`` tagged-template call sites in lib/tools/*.
 * The real postgres client is constructed on first invocation (request time),
 * not at module import, so `next build` can collect page data without DATABASE_URL.
 */
export const sql = new Proxy(function () {} as unknown as SqlClient, {
  apply(_target, _thisArg, argArray: unknown[]) {
    const client = getClient() as unknown as (...a: unknown[]) => unknown;
    return client(...argArray);
  },
  get(_target, prop) {
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
}) as SqlClient;
