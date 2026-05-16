"use client";

import { useCallback, useState } from "react";

export type ExecuteState = "idle" | "executing" | "success" | "error";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error("Response was not valid JSON");
  }
  if (!res.ok) {
    const errMsg = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

export function useExecuteQuery() {
  const [state, setState] = useState<ExecuteState>("idle");
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (opts: {
      chatId: string;
      sourceTurnId: string;
      sqlText: string;
      knownQueryId?: string | null;
    }) => {
      setState("executing");
      setError(null);

      try {
        let queryId = opts.knownQueryId ?? null;
        if (!queryId) {
          const enq = await postJson<{ query_id?: string }>(
            "/api/pending-queries/enqueue",
            {
              chat_id: opts.chatId,
              source_turn_id: opts.sourceTurnId,
              sql_text: opts.sqlText,
            },
          );
          queryId = enq?.query_id ?? null;
          if (!queryId) throw new Error("enqueue did not return query_id");
        }

        let subData: unknown;
        try {
          subData = await postJson<unknown>("/api/submit-sql", {
            sql_text: opts.sqlText,
          });
        } catch (subErr) {
          const msg = subErr instanceof Error ? subErr.message : String(subErr);
          await postJson("/api/pending-queries/mark-failed", {
            query_id: queryId,
            failure_reason: msg,
          }).catch(() => {});
          setError(msg);
          setState("error");
          return;
        }

        const envelope = (subData ?? {}) as {
          error?: string | null;
          audit_submission_id?: string | null;
        };

        if (envelope.error) {
          await postJson("/api/pending-queries/mark-failed", {
            query_id: queryId,
            failure_reason: envelope.error,
          }).catch(() => {});
          setError(envelope.error);
          setState("error");
          return;
        }

        await postJson("/api/pending-queries/mark-executed", {
          query_id: queryId,
          result_payload: subData,
          submit_sql_audit_id: envelope.audit_submission_id ?? null,
        });
        setState("success");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setState("error");
      }
    },
    [],
  );

  const reject = useCallback(async (queryId: string) => {
    setState("executing");
    setError(null);
    try {
      await postJson("/api/pending-queries/mark-failed", {
        query_id: queryId,
        failure_reason: "REJECTED_BY_USER",
      });
      setState("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState("error");
    }
  }, []);

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
  }, []);

  return { execute, reject, state, error, reset };
}
