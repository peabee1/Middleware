import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/server-supabase";

export async function POST(req: NextRequest) {
  let body: { chat_id?: string; source_turn_id?: string; sql_text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { chat_id, source_turn_id, sql_text } = body;
  if (!chat_id || !source_turn_id || !sql_text) {
    return NextResponse.json(
      { error: "Missing required field(s): chat_id, source_turn_id, sql_text" },
      { status: 400 },
    );
  }
  const supabase = getServerSupabase();
  const { data, error } = await supabase.rpc("enqueue_pending_query", {
    p_chat_id: chat_id,
    p_source_turn_id: source_turn_id,
    p_sql_text: sql_text,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
