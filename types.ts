
export type ConversationTurn = {
  turn_id: string;
  chat_id: string;
  turn_sequence: number;
  role: 'USER' | 'ASSISTANT';
  content: string;
  thinking_content: string | null;
  tool_calls_made: unknown | null;
  content_hash: string;
  turn_timestamp: string;
  created_at: string;
};

export type PendingQueryStatus = 'PENDING' | 'EXECUTED' | 'FAILED' | 'CONSUMED';

export type PendingQuery = {
  query_id: string;
  chat_id: string;
  source_turn_id: string | null;
  sql_text: string;
  status: PendingQueryStatus;
  detected_at: string;
  executed_at: string | null;
  consumed_at: string | null;
  result_payload: unknown | null;
  failure_reason: string | null;
  submit_sql_audit_id: string | null;
};

export type AgentRole = 'JUNIOR' | 'SENIOR' | 'DEV';

export type LatestChatPerRole = {
  chat_id: string;
  agent_role: AgentRole;
  latest_turn_timestamp: string | null;
};
