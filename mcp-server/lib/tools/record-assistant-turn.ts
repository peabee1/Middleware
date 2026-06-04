import { sql } from '../db';
import type { RecordTurnResult } from '../types';

export interface RecordAssistantTurnParams {
  chat_id: string;
  response_content: string;
  thinking_content?: string;
  tool_calls_made?: unknown[];
  turn_timestamp?: string;
  turn_sequence?: number;
}

/**
 * record_assistant_turn — captures Claude's response (visible content + thinking,
 * separately demarcated) at the end of a turn.
 *
 * Spec: DOC-REQ-SPR050-001 §4.2 (tool spec), §5.5 (substrate SP).
 *
 * Substrate SP signature:
 *   record_assistant_turn(
 *     p_chat_id, p_response_content, p_thinking_content,
 *     p_tool_calls_made, p_turn_timestamp, p_turn_sequence
 *   ) → JSONB
 *
 * Idempotent on (chat_id, content_hash). Returns existing turn_id with
 * status=DUPLICATE on retry of the same content; new turn_id with
 * status=RECORDED otherwise.
 *
 * Edge cases handled by the SP:
 *   - empty response_content      → ERROR_EMPTY_CONTENT
 *   - unknown chat_id             → ERROR_CHAT_NOT_FOUND (no auto-creation)
 *   - thinking_content > 50KB     → accepted but logged as thinking-bloat warning
 *
 * tool_calls_made is JSONB on the substrate side; passed as a JSON-encoded text
 * literal cast to jsonb. Casting NULL through ::jsonb yields NULL, so the
 * undefined-input case is handled cleanly.
 */
export async function recordAssistantTurn(
  params: RecordAssistantTurnParams
): Promise<RecordTurnResult> {
  const {
    chat_id,
    response_content,
    thinking_content,
    tool_calls_made,
    turn_timestamp,
    turn_sequence,
  } = params;

  const toolCallsJson =
    tool_calls_made !== undefined ? JSON.stringify(tool_calls_made) : null;

  const rows = await sql<{ result: RecordTurnResult }[]>`
    SELECT record_assistant_turn(
      ${chat_id}::text,
      ${response_content}::text,
      ${thinking_content ?? null}::text,
      ${toolCallsJson}::jsonb,
      ${turn_timestamp ?? null}::timestamptz,
      ${turn_sequence ?? null}::integer
    ) AS result
  `;

  return rows[0].result;
}
