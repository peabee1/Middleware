import { sql } from '../db';
import type { GetQueryResultResponse } from '../types';

export interface GetQueryResultParams {
  chat_id: string;
  include_pending?: boolean;
  mark_consumed?: boolean;
  /** Precision fetch: return only this query, ignoring the status filter. */
  query_id?: string;
  /** Lean payload (default true): compact rows omitting full sql_text + audit fields. */
  lean?: boolean;
}

/**
 * get_query_result — retrieves the result of SQL queries that Paul has executed
 * via the MVP UI's [Execute] button.
 *
 * Spec: DOC-REQ-SPR050-001 §4.3 (tool spec), §5.5 (substrate SP).
 *
 * Substrate SP signature (5-arg):
 *   get_query_result(p_chat_id, p_include_pending, p_mark_consumed,
 *                    p_query_id, p_lean) → JSONB
 *
 * Returns:
 *   { results: PendingQueryRow[], count: number }   on success
 *   { status: 'ERROR_CHAT_NOT_FOUND', error: ... }  if chat_id is unknown
 *
 * Defaults: include_pending=false, mark_consumed=true, query_id=null, lean=true.
 * query_id (when set) is a precision fetch — returns only that query and ignores
 * the status filter. lean=true returns the compact row shape (sql_preview instead
 * of full sql_text). On mark_consumed=true, executed rows returned by this call
 * are flipped to status=CONSUMED so future calls do not re-return them.
 */
export async function getQueryResult(
  params: GetQueryResultParams
): Promise<GetQueryResultResponse> {
  const {
    chat_id,
    include_pending = false,
    mark_consumed = true,
    query_id,
    lean = true,
  } = params;

  const rows = await sql<{ result: GetQueryResultResponse }[]>`
    SELECT get_query_result(
      ${chat_id}::text,
      ${include_pending}::boolean,
      ${mark_consumed}::boolean,
      ${query_id ?? null}::text,
      ${lean}::boolean
    ) AS result
  `;

  return rows[0].result;
}
