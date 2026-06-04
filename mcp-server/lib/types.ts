/**
 * Type definitions matching substrate stored procedure return shapes.
 * Source of truth: DOC-REQ-SPR050-001 §4 (MCP tool spec) and §5.5 (MCP-backing SPs).
 *
 * Substrate SPs return JSONB which arrives in JS as plain objects.
 */

// ---- record_user_turn / record_assistant_turn ----

export type RecordTurnStatus =
  | 'RECORDED'
  | 'DUPLICATE'
  | 'ERROR_EMPTY_CONTENT'
  | 'ERROR_CHAT_NOT_FOUND';

export interface RecordTurnResult {
  turn_id?: string;
  status: RecordTurnStatus;
  sequence?: number;
  error?: string;
}

// ---- get_query_result ----

export type QueryStatus = 'PENDING' | 'EXECUTED' | 'FAILED' | 'CONSUMED';

export interface PendingQueryRow {
  query_id: string;
  sql_text: string;
  status: QueryStatus;
  result_payload?: unknown;
  executed_at?: string;
  submit_sql_audit_id?: string;
}

export type GetQueryResultResponse =
  | { results: PendingQueryRow[]; count: number }
  | { status: 'ERROR_CHAT_NOT_FOUND'; error: string };
