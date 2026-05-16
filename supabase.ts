import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Lazy-initialised Supabase client.
 *
 * Throws at first call (not at module load) if either
 * NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing —
 * keeps the bundle safe to import in environments where env is not yet
 * configured (e.g. CI typecheck without secrets).
 */
export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.",
    );
  }

  cached = createClient(url, anonKey, {
    auth: { persistSession: false },
  });
  return cached;
}
