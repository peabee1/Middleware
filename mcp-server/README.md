# Middleware MCP server

MCP server bridging Claude.ai chats and the Supabase substrate. Part of EPIC-2 Middleware-MVP per `DOC-REQ-SPR050-001`.

## Architecture

- **Runtime**: Next.js App Router on Vercel Functions (Fluid Compute).
- **MCP**: `mcp-handler` package (Vercel-canonical wrapper) over `@modelcontextprotocol/sdk`. Streamable HTTP transport.
- **DB**: `postgres` (porsager) against Supabase via the Transaction Pooler (port 6543). `prepare: false` is required for transaction-mode poolers.

Per `DEC-311`. Per `DOC-REQ-SPR050-001 §8.1`, this lives in its own subdirectory of the existing `peabee1/Middleware` repo — the SQL Query Tool at the repo root is untouched.

## L1 tool surface (per §4 of the brief)

| Tool                    | Status in this slice (SPR-061) |
| ----------------------- | ------------------------------ |
| `record_user_turn`      | **Implemented**                |
| `record_assistant_turn` | **Implemented**                |
| `get_query_result`      | **Implemented**                |

All three L1 MCP tools are wired against their backing substrate SPs. Server-side L1 is complete; remaining L1 work (MVP UI: SQL detection, Execute button, result rendering) is a separate codebase per §8.1 and a separate sprint.

## Local development

```bash
cd mcp-server
npm install
cp .env.example .env.local      # then fill in DATABASE_URL
npm run dev
```

Default dev URL: `http://localhost:3000`. MCP endpoint: `http://localhost:3000/api/mcp`.

### Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

In the inspector:

1. Transport: **Streamable HTTP**
2. URL: `http://localhost:3000/api/mcp`
3. Click Connect → List Tools → invoke `record_user_turn` with a real `chat_id`.

## Environment

`DATABASE_URL` is the only required variable.

Use Supabase&rsquo;s Transaction Pooler connection string (port 6543), not the direct connection (5432). Serverless invocations would otherwise exhaust the connection cap.

Get it from Supabase dashboard → Settings → Database → Connection string → "Transaction" mode → URI.

### DB role permissions

The role in `DATABASE_URL` needs:

- `EXECUTE` on the substrate SPs: `record_user_turn`, `record_assistant_turn`, `get_query_result` (and the MVP-backing ones for later: `enqueue_pending_query`, `mark_query_executed`, `mark_query_failed`).
- The SPs run as `SECURITY INVOKER` (verified in SPR-061), so the role also needs `INSERT`/`SELECT`/`UPDATE` on `conversation_turns`, `pending_queries`, `agent_states` as appropriate.

Simplest: use the Supabase `service_role` for now (it bypasses RLS). Tighten later if/when needed.

## Deploy to Vercel

1. In Vercel, create a new project pointing at `peabee1/Middleware`.
2. Set **Root Directory** to `mcp-server` (so Vercel doesn&rsquo;t try to build the SQL Query Tool at the repo root).
3. Set environment variable `DATABASE_URL` (Production + Preview).
4. Deploy. The MCP endpoint will be at `https://<your-project>.vercel.app/api/mcp`.

## Repository structure

```
peabee1/Middleware/
├── sql-query-tool/        (existing — vanilla HTML/CSS/JS, untouched)
├── mcp-server/            (this directory)
│   ├── app/
│   │   ├── api/mcp/route.ts      # MCP handler + tool registration
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── lib/
│   │   ├── db.ts                  # postgres porsager singleton
│   │   ├── types.ts               # shared types
│   │   └── tools/
│   │       ├── record-user-turn.ts
│   │       ├── record-assistant-turn.ts
│   │       └── get-query-result.ts
│   ├── .env.example
│   ├── .gitignore
│   ├── next.config.js
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
└── README.md              (top-level — optional)
```

## What this does NOT include

Per `DOC-REQ-SPR050-001 §8`:

- **MVP UI** — separate codebase, separate sprint slice.
- **Auth** — single-user (Paul); no auth surface beyond what protects Supabase access.
- **OAuth on the MCP endpoint** — unsecured for MVP. Vercel Deployment Protection or Vercel Firewall is the cheapest path to gate access if needed before public exposure.
