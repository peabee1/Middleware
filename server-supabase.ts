// lib/server-supabase.ts
// IMPORT ONLY FROM app/api/** route handlers.
// SUPABASE_SERVICE_ROLE_KEY must NEVER enter the client bundle.
// Per DEC-360 (browser-resident substrate I/O posture) + DEC-359 (REPO-MVP-UI tactical).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!serviceKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (server-only; do not prefix NEXT_PUBLIC_)");
  }
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
