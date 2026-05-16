# REPO-MVP-UI

Web UI for the multi-agent workflow MVP — the chat surface side of the
Middleware-MVP. Spec: `DOC-REQ-SPR050-001` (Middleware-MVP REQ brief),
particularly §6 (UI components).

## Status

**Scaffold only.** L1 components (§6.1 conversation rendering, §6.2 query
queue, §6.3 result display) land in subsequent sprints. Deploy gated on
Junior MT-575 (publish_repo SP) and MT-576 (supersede_decision SP),
tracked under DEC-331.

## Stack

- Next.js 15 (App Router)
- React 19
- TypeScript
- Tailwind CSS (shadcn/ui foundation prepared)
- @supabase/supabase-js

Stack rationale: see DEC-331 cluster + scaffold ticket MT-586.

## Substrate-canonical

This repo is **substrate-canonical** per DEC-323/324/325 → DEC-331. The
authoritative source of truth for every file is the substrate
`code_section_versions` row, not any clone of this repo. Local edits flow
back to substrate via the agreed pattern; substrate exports to deploy
targets via `publish_repo` (Junior MT-575, in progress).

## Local development

1. Copy `.env.example` to `.env.local` and fill in Supabase URL + anon key.
2. Install dependencies: `npm install`.
3. Run dev server: `npm run dev`.
4. Open `http://localhost:3000`.

## Conventions

- Type-checked builds (`npm run typecheck`).
- Lint clean (`npm run lint`).
- All UI consumes substrate via the `getSupabase()` factory in
  `lib/supabase.ts`.
