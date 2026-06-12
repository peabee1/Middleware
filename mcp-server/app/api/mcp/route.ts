import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import { recordUserTurn } from '@/lib/tools/record-user-turn';
import { recordAssistantTurn } from '@/lib/tools/record-assistant-turn';
import { getQueryResult } from '@/lib/tools/get-query-result';

/**
 * MCP server route handler.
 *
 * Endpoint: /api/mcp (Streamable HTTP transport).
 * Spec: DOC-REQ-SPR050-001 §4 (tool spec).
 *
 * Three L1 tools registered: record_user_turn, record_assistant_turn,
 * get_query_result. All call substrate SPs that enforce semantics
 * (idempotency, validation, edge cases). The MCP layer is intentionally thin.
 */

function asTextResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

function asErrorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'ERROR_INTERNAL', error: message }),
      },
    ],
  };
}

const handler = createMcpHandler(
  (server) => {
    // ---- §4.1 record_user_turn ----
    server.tool(
      'record_user_turn',
      'Captures a user message to substrate at the start of a Claude turn. Idempotent on (chat_id, content_hash).',
      {
        chat_id: z.string().describe('Current chat ID, e.g. CHT-067'),
        turn_content: z.string().min(1).describe("The user's full message text"),
        turn_timestamp: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe('ISO 8601 timestamp; defaults to NOW() if omitted'),
        turn_sequence: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Ordinal within chat; auto-derived if omitted'),
      },
      async (params) => {
        try {
          return asTextResult(await recordUserTurn(params));
        } catch (err) {
          return asErrorResult(err);
        }
      }
    );

    // ---- §4.2 record_assistant_turn ----
    server.tool(
      'record_assistant_turn',
      "Captures Claude's response (visible content + thinking, separately) at the end of a turn. Idempotent on (chat_id, content_hash).",
      {
        chat_id: z.string(),
        response_content: z.string().min(1),
        thinking_content: z.string().optional(),
        tool_calls_made: z.array(z.unknown()).optional(),
        turn_timestamp: z.string().datetime({ offset: true }).optional(),
        turn_sequence: z.number().int().nonnegative().optional(),
      },
      async (params) => {
        try {
          return asTextResult(await recordAssistantTurn(params));
        } catch (err) {
          return asErrorResult(err);
        }
      }
    );

    // ---- §4.3 get_query_result ----
    server.tool(
      'get_query_result',
      'Retrieves results of SQL queries Paul has executed via the MVP UI. Returns executed rows for this chat; on mark_consumed=true (default) flips them to CONSUMED so they are not returned again. Pass query_id to fetch one specific query result instead of all unconsumed rows.',
      {
        chat_id: z.string(),
        include_pending: z.boolean().optional().default(false),
        mark_consumed: z.boolean().optional().default(true),
        query_id: z
          .string()
          .optional()
          .describe(
            'Precision fetch: return only this query (e.g. QRY-CHT-067-0003), ignoring the status filter. Omit to return all unconsumed executed/failed rows for the chat.'
          ),
        lean: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Lean payload (default true): compact rows with sql_preview and result_payload, omitting full sql_text and audit fields. Set false for the full row shape.'
          ),
      },
      async (params) => {
        try {
          return asTextResult(await getQueryResult(params));
        } catch (err) {
          return asErrorResult(err);
        }
      }
    );
  },
  {},
  { basePath: '/api' }
);

export { handler as GET, handler as POST, handler as DELETE };
