import { sql } from '../db';
import type { GetQueryResultResponse } from '../types';

export interface GetQueryResultParams {
  chat_id: string;
  include_pending?: boolean;
  mark_consumed?: boolean;
}

/**
 * get_query_result — retrieves the result of SQL queries that Paul has executed
 * via the MVP UI's [Execute] button.
 *
 * Spec: DOC-REQ-SPR050-001 §4.3 (tool spec), §5.5 (substrate SP).
 *
 * Substrate SP signature:
 *   get_query_result(p_chat_id, p_include_pending, p_mark_consumed) → JSONB
 *
 * Returns:
 *   { results: PendingQueryRow[], count: number }   on success
 *   { status: 'ERROR_CHAT_NOT_FOUND', error: ... }  if chat_id is unknown
 *
 * Defaults match the §4.3 contract: include_pending=false, mark_consumed=true.
 * On mark_consumed=true, executed rows returned by this call are flipped to
 * status=CONSUMED so future calls do not re-return them.
 */
export async function getQueryResult(
  params: GetQueryResultParams
): Promise<GetQueryResultResponse> {
  const { chat_id, include_pending = false, mark_consumed = true } = params;

  const rows = await sql<{ result: GetQueryResultResponse }[]>`
    SELECT get_query_result(
      ${chat_id}::text,
      ${include_pending}::boolean,
      ${mark_consumed}::boolean
    ) AS result
  `;

  return rows[0].result;
}
