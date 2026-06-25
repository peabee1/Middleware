import { sql } from '../db';

export interface EnqueueWriteParams {
  chat_id: string;
  source_turn_id: string;
  sp_name: string;
  sp_params: Record<string, unknown>;
}

export type EnqueueWriteStatus =
  | 'QUEUED'
  | 'ERROR_REFUSED'
  | 'ERROR_VALIDATION'
  | 'ERROR_INTERNAL';

export interface EnqueueWriteResponse {
  status: EnqueueWriteStatus;
  /** Present on QUEUED: the pending_queries row ID. */
  queue_entry_id?: string;
  /** Present on QUEUED: the SQL that was enqueued (for operator visibility). */
  enqueued_sql?: string;
  /** Present on ERROR_*: human-readable error detail. */
  error?: string;
}

/**
 * Refuses SQL patterns that look like raw DML or DDL rather than SP calls.
 * This is a belt-and-suspenders guard — the substrate Flight Deck already
 * requires human approval before execution. But we should refuse at enqueue
 * time rather than silently queue something malformed.
 */
const REFUSED_PATTERNS = [
  /^\s*INSERT\s+INTO\b/i,
  /^\s*UPDATE\s+\w/i,
  /^\s*DELETE\s+FROM\b/i,
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+/i,
];

function buildSpCall(spName: string, params: Record<string, unknown>): string {
  // Builds: SELECT sp_name($1::jsonb) with the params JSON as the single argument.
  // All substrate write SPs accept a JSONB payload as their primary parameter,
  // or a set of typed parameters — we use the JSONB variant where available.
  // The resulting SQL is a valid SELECT callable via the Flight Deck submit_sql path.
  const paramsJson = JSON.stringify(params);
  return `SELECT ${spName}('${paramsJson.replace(/'/g, "''")}'::jsonb)`;
}

function isValidSpName(name: string): boolean {
  // SP names must be lowercase alphanumeric + underscores only. No schema prefix needed
  // since all substrate SPs are in the public schema. Guards against SQL injection
  // via the sp_name field.
  return /^[a-z][a-z0-9_]{0,62}$/.test(name);
}

/**
 * enqueue_write — Leg 2 gated write queue tool.
 *
 * Accepts a structured SP call (name + JSONB params), builds the SQL,
 * and inserts it directly into the Flight Deck execution queue via
 * enqueue_pending_query. Returns a queue_entry_id. Raw DML is refused.
 * Human gate (Paul approves in Flight Deck) is unchanged — this tool
 * only enqueues; it never executes.
 *
 * Spec: MT-670 / DOC-REQ-SPR138-001 Leg 2.
 *
 * SP signature:
 *   enqueue_pending_query(p_chat_id text, p_source_turn_id text, p_sql_text text) → jsonb
 */
export async function enqueueWrite(
  params: EnqueueWriteParams
): Promise<EnqueueWriteResponse> {
  const { chat_id, source_turn_id, sp_name, sp_params } = params;

  // Validate SP name.
  if (!sp_name || !isValidSpName(sp_name)) {
    return {
      status: 'ERROR_VALIDATION',
      error:
        'sp_name must be a valid PostgreSQL identifier (lowercase letters, digits, underscores; max 63 chars).',
    };
  }

  // Build the SP call SQL.
  const enqueuedSql = buildSpCall(sp_name, sp_params);

  // Belt-and-suspenders: refuse if the built SQL matches raw DML patterns
  // (should be impossible given the builder, but guard anyway).
  for (const pattern of REFUSED_PATTERNS) {
    if (pattern.test(enqueuedSql)) {
      return {
        status: 'ERROR_REFUSED',
        error: `Refused: generated SQL matches a prohibited raw DML/DDL pattern. Use an SP call.`,
      };
    }
  }

  try {
    const rows = await sql<{ result: unknown }[]>`
      SELECT enqueue_pending_query(
        ${chat_id}::text,
        ${source_turn_id}::text,
        ${enqueuedSql}::text
      ) AS result
    `;

    const raw = rows[0]?.result as Record<string, unknown> | null;

    if (!raw) {
      return { status: 'ERROR_INTERNAL', error: 'SP returned null' };
    }

    const spStatus = raw['status'] as string | undefined;

    if (spStatus === 'ERROR' || spStatus === 'ERROR_INTERNAL') {
      return {
        status: 'ERROR_INTERNAL',
        error: (raw['error'] as string) || 'Unknown SP error',
      };
    }

    const queryId = raw['query_id'] as string | undefined;

    return {
      status: 'QUEUED',
      queue_entry_id: queryId,
      enqueued_sql: enqueuedSql,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'ERROR_INTERNAL', error: message };
  }
}
