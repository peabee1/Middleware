import { sql } from '../db';
import type { RecordTurnResult } from '../types';

export interface RecordUserTurnParams {
  chat_id: string;
  turn_content: string;
  turn_timestamp?: string;
  turn_sequence?: number;
}

/**
 * record_user_turn — captures a user message to substrate at the start of a Claude turn.
 *
 * Spec: DOC-REQ-SPR050-001 §4.1 (tool spec), §5.5 (substrate SP).
 *
 * Substrate SP signature:
 *   record_user_turn(p_chat_id, p_turn_content, p_turn_timestamp, p_turn_sequence) → JSONB
 *
 * Idempotent on (chat_id, content_hash). Returns existing turn_id with status=DUPLICATE
 * on retry of the same content; new turn_id with status=RECORDED otherwise.
 *
 * Edge cases handled by the SP:
 *   - empty content        → ERROR_EMPTY_CONTENT
 *   - unknown chat_id      → ERROR_CHAT_NOT_FOUND (no auto-creation)
 */
export async function recordUserTurn(
  params: RecordUserTurnParams
): Promise<RecordTurnResult> {
  const { chat_id, turn_content, turn_timestamp, turn_sequence } = params;

  // postgres.js `sql` template handles parameterization and type coercion.
  // Explicit ::text / ::timestamptz / ::integer casts disambiguate NULL parameters
  // for the SP signature.
  const rows = await sql<{ result: RecordTurnResult }[]>`
    SELECT record_user_turn(
      ${chat_id}::text,
      ${turn_content}::text,
      ${turn_timestamp ?? null}::timestamptz,
      ${turn_sequence ?? null}::integer
    ) AS result
  `;

  return rows[0].result;
}
