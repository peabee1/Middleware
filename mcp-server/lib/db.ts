import postgres from 'postgres';

/**
 * Postgres connection (porsager/postgres).
 *
 * Configured for Supabase Transaction Pooler (port 6543):
 *   - prepare: false   — required; transaction-mode poolers don't preserve prepared statements
 *   - max: 1           — minimize connections per serverless instance; rely on pooler
 *   - idle_timeout: 20 — release idle connections quickly
 *   - ssl: 'require'    — Supabase requires TLS; 'require' encrypts without cert-hostname verification
 *
 * CONNECTION BY DISCRETE PARAMS (MT-625): the client is built from discrete
 * { host, port, username, password, database } fields rather than by handing the
 * raw DATABASE_URL string to postgres(). porsager parses a URL via `new URL()`,
 * which throws "Invalid URL" when the password contains unencoded reserved
 * characters (/, #, ?, %, space, @, :) — the SPR-109 capture-activation blocker.
 * Sourcing the password as a raw substring — never URL-decoded — means any
 * password works and URL-encoding is never required.
 *
 * Fields come from discrete PG* env vars when a complete set is present, otherwise
 * from a reserved-char-safe manual parse of DATABASE_URL (NOT new URL()).
 *
 * LAZY INITIALISATION: the client is created on first use, not at module import.
 * `next build` imports route modules during the "collect page data" phase; an
 * eager module-scope throw on missing config fails the build even though the
 * variables are present at runtime. Deferring creation to the first query keeps
 * the build environment-free. Cached on globalThis for reuse across warm invocations.
 */

type SqlClient = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __sql: SqlClient | undefined;
}

interface ConnFields {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

/**
 * Parse a postgres connection string into discrete fields WITHOUT `new URL()`.
 * The password is taken as a raw substring and never percent-decoded, so reserved
 * characters (/, #, ?, %, space, @, :) survive intact. Disambiguation is structural:
 *   - userinfo / hostinfo split on the LAST '@'   (password may contain '@')
 *   - username / password split on the FIRST ':'  (password may contain ':')
 *   - database path begins at the first '/' AFTER the host (any '/' in the password
 *     sits left of the last '@', so it is already inside userinfo)
 */
function parseConnectionString(cs: string): ConnFields {
  const schemeMatch = /^postgres(?:ql)?:\/\/(.*)$/s.exec(cs.trim());
  if (!schemeMatch) {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  }
  const rest = schemeMatch[1];

  const at = rest.lastIndexOf('@');
  if (at === -1) {
    throw new Error('DATABASE_URL is missing "@" between credentials and host');
  }
  const userinfo = rest.slice(0, at);
  const hostinfoRaw = rest.slice(at + 1);

  const colon = userinfo.indexOf(':');
  if (colon === -1) {
    throw new Error('DATABASE_URL is missing ":" between username and password');
  }
  const username = userinfo.slice(0, colon); // raw — not decoded
  const password = userinfo.slice(colon + 1); // raw — not decoded

  // Drop any ?query / #fragment before locating the database path.
  const hostinfo = hostinfoRaw.split('?')[0].split('#')[0];

  const slash = hostinfo.indexOf('/');
  const hostport = slash === -1 ? hostinfo : hostinfo.slice(0, slash);
  const database =
    slash === -1 ? 'postgres' : hostinfo.slice(slash + 1) || 'postgres';

  const portColon = hostport.lastIndexOf(':');
  if (portColon === -1) {
    throw new Error('DATABASE_URL is missing the host port');
  }
  const host = hostport.slice(0, portColon);
  const port = Number.parseInt(hostport.slice(portColon + 1), 10);
  if (!host || Number.isNaN(port)) {
    throw new Error('DATABASE_URL host/port could not be parsed');
  }

  return { host, port, username, password, database };
}

function resolveFields(): ConnFields {
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, DATABASE_URL } =
    process.env;

  // Prefer discrete env vars when a complete set is provided.
  if (PGHOST && PGUSER && PGPASSWORD) {
    return {
      host: PGHOST,
      port: PGPORT ? Number.parseInt(PGPORT, 10) : 6543,
      username: PGUSER,
      password: PGPASSWORD,
      database: PGDATABASE || 'postgres',
    };
  }

  if (!DATABASE_URL) {
    throw new Error(
      'Database configuration missing. Set DATABASE_URL (Supabase Transaction ' +
        'Pooler, port 6543) or the discrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE vars.'
    );
  }

  return parseConnectionString(DATABASE_URL);
}

function buildClient(): SqlClient {
  const { host, port, username, password, database } = resolveFields();
  return postgres({
    host,
    port,
    username,
    password,
    database,
    ssl: 'require',
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
}

/**
 * MT-627: cached client validation.
 *
 * porsager/postgres constructs the client eagerly at call time but does not
 * connect until the first query. On a warm Vercel instance the cached client
 * on globalThis.__sql may carry stale or invalid credentials from a prior cold
 * start — it will not fail until a query is actually issued, at which point
 * every subsequent request in the warm window also fails.
 *
 * Fix: before returning a cached client, probe it with `SELECT 1`. If the probe
 * throws (auth failure, connection refused, timeout) we discard the bad client,
 * build a fresh one, and return that instead. The probe adds ~1 RTT on the first
 * request of each warm window but prevents a bad client from persisting.
 */
async function validateClient(client: SqlClient): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function getClient(): SqlClient {
  if (!globalThis.__sql) {
    globalThis.__sql = buildClient();
  }
  return globalThis.__sql;
}

/**
 * Returns a validated client, rebuilding if the cached client fails a probe.
 * Call this from query sites instead of getClient() directly when credential
 * rotation or bad-start persistence is a concern.
 */
export async function getValidatedClient(): Promise<SqlClient> {
  const client = getClient();
  if (await validateClient(client)) return client;
  // Probe failed — discard and rebuild.
  globalThis.__sql = buildClient();
  return globalThis.__sql;
}

/**
 * Lazy proxy preserving the `sql`...`` tagged-template call sites in lib/tools/*.
 * The real postgres client is constructed on first invocation (request time),
 * not at module import, so `next build` can collect page data without config.
 *
 * MT-627: the apply trap is async so it can validate (and if necessary rebuild)
 * the cached client before delegating. Since every postgres tagged-template call
 * returns a Promise, callers are already awaiting — the async trap is transparent.
 */
export const sql = new Proxy(function () {} as unknown as SqlClient, {
  apply(_target, _thisArg, argArray: unknown[]) {
    return (async () => {
      const client = await getValidatedClient() as unknown as (...a: unknown[]) => unknown;
      return client(...argArray);
    })();
  },
  get(_target, prop) {
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
}) as SqlClient;
