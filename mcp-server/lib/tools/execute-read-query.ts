import { sql } from '../db';

export interface ExecuteReadQueryParams {
  sql_text: string;
  chat_id: string;
}

export type ExecuteReadQueryStatus =
  | 'OK'
  | 'REFUSED'
  | 'ERROR_EMPTY_SQL'
  | 'ERROR_INTERNAL';

export interface ExecuteReadQueryResponse {
  status: ExecuteReadQueryStatus;
  /** Present on OK: the rows returned by the query. */
  result?: unknown[];
  /** Present on OK: substrate audit sequence number. */
  audit_seq?: string;
  /** Present on OK: query execution duration in ms. */
  duration_ms?: number;
  /** Present on REFUSED: the reason the query was rejected. */
  refused_reason?: string;
  /** Present on ERROR_*: human-readable error detail. */
  error?: string;
}

/**
 * execute_read_query — synchronous consent-free read execution.
 *
 * Calls the substrate SP execute_introspection_only(p_sql, p_context) which
 * enforces read-only at the database level (DML, DDL, and multi-statement
 * queries are refused before execution). Returns rows + audit metadata inline,
 * callable by the agent mid-turn without a Flight Deck round-trip.
 *
 * Spec: MT-667 / DOC-REQ-SPR138-001 Leg 1.
 *
 * SP signature:
 *   execute_introspection_only(p_sql text, p_context jsonb DEFAULT NULL) → jsonb
 *
 * p_context carries {"chat_id": "<chat_id>"} for audit traceability.
 *
 * Hard scope guard: the SP enforces read-only — this tool never executes writes.
 * The MCP layer adds no additional classifier; substrate enforcement is authoritative.
 */
export async function executeReadQuery(
  params: ExecuteReadQueryParams
): Promise<ExecuteReadQueryResponse> {
  const { sql_text, chat_id } = params;

  if (!sql_text || !sql_text.trim()) {
    return { status: 'ERROR_EMPTY_SQL', error: 'sql_text must not be empty' };
  }

  const context = JSON.stringify({ chat_id });

  try {
    const rows = await sql<{ result: unknown }[]>`
      SELECT execute_introspection_only(
        ${sql_text}::text,
        ${context}::jsonb
      ) AS result
    `;

    const raw = rows[0]?.result as Record<string, unknown> | null;

    if (!raw) {
      return { status: 'ERROR_INTERNAL', error: 'SP returned null' };
    }

    // SP returns status field to signal REFUSED vs OK.
    const spStatus = raw['status'] as string | undefined;

    if (spStatus === 'REFUSED' || spStatus === 'ERROR_REFUSED') {
      return {
        status: 'REFUSED',
        refused_reason:
          (raw['refused_reason'] as string) ||
          (raw['error'] as string) ||
          'Query refused by substrate read-only enforcer',
      };
    }

    if (spStatus === 'ERROR' || spStatus === 'ERROR_INTERNAL') {
      return {
        status: 'ERROR_INTERNAL',
        error: (raw['error'] as string) || 'Unknown SP error',
      };
    }

    // Success — surface rows and audit fields.
    return {
      status: 'OK',
      result: (raw['result'] as unknown[]) ?? [],
      audit_seq: raw['audit_seq'] as string | undefined,
      duration_ms: raw['duration_ms'] as number | undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'ERROR_INTERNAL', error: message };
  }
}
