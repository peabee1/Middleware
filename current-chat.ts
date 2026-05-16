import type { LatestChatPerRole } from "./types";

export async function getLatestChatPerRole(): Promise<LatestChatPerRole[]> {
  const res = await fetch("/api/chats/latest-per-role");
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        errMsg = String((parsed as { error: unknown }).error);
      }
    } catch {
      // fall through with HTTP status
    }
    throw new Error(errMsg);
  }
  const data = (await res.json()) as LatestChatPerRole[];
  return data;
}
