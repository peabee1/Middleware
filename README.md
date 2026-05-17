# SQL Query Tool

A browser-based tool for low-friction SQL round-trips against a Supabase PostgREST endpoint. Built to replace the 12-clicks-per-round-trip mobile workflow with a paste → format → submit → copy cycle.

Single-page static app. No backend, no build step, no framework. Vanilla HTML/CSS/JS that any static host will serve.

---

## Quick deploy

Pick one. All are free.

### Option A — GitHub Pages (recommended)

1. Create a new public repo on GitHub (e.g. `sql-query-tool`).
2. Upload `index.html`, `app.css`, `app.js` to the repo root.
3. In repo settings → Pages, set source to "Deploy from branch", branch `main` / `(root)`.
4. Wait ~30 seconds. Tool lives at `https://<username>.github.io/sql-query-tool/`.

### Option B — Vercel (drag and drop)

1. Go to [vercel.com/new](https://vercel.com/new).
2. Drag the project folder onto the page (or import from GitHub).
3. Accept defaults (no framework, no build command, output dir `.`).
4. Tool lives at `https://<project>.vercel.app/`.

### Option C — Netlify Drop

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag the project folder onto the page.
3. Tool lives at the URL Netlify gives you (rename in site settings if you want a stable slug).

### Option D — Local file (testing only)

Open `index.html` directly in a browser (file://). Note: `navigator.clipboard.writeText` requires HTTPS or localhost. The tool falls back to `document.execCommand('copy')` but local file usage is best treated as a dev-only smoke test, not a durable surface.

---

## File structure

```
sql-query-tool/
├── index.html      Page shell
├── app.css         Styles
├── app.js          SQL parser, PostgREST client, UI logic
├── test.js         Node test suite for the parser (optional)
└── README.md       This file
```

`test.js` is not deployed — it's purely for verifying parser behaviour locally with `node test.js`. The deployable surface is the three asset files.

---

## Configuration

The Supabase URL and publishable key are hardcoded near the top of `app.js`:

```js
const SUPABASE_URL = 'https://lkjskaygaijyelfqwoln.supabase.co';
const SUPABASE_KEY = 'sb_publishable_P78xr2RFEkj-3-n0ZB0XdA_KMFgu_Ji';
```

These are public-by-design — the publishable key is intended for browser-side use, and Row Level Security (RLS) policies on the database enforce access control. No secret keys live in this project.

To point the tool at a different Supabase project, edit those two lines.

---

## Supported SQL

The tool translates a deliberately small SQL subset into PostgREST calls. Two patterns:

### 1. SELECT FROM table

```sql
SELECT cols FROM table [WHERE conditions] [ORDER BY cols] [LIMIT n]
```

WHERE conditions support:

| SQL                        | PostgREST                  |
| -------------------------- | -------------------------- |
| `col = 'val'`              | `col=eq.val`               |
| `col != 'val'` or `col <>` | `col=neq.val`              |
| `col < n`, `>`, `<=`, `>=` | `col=lt.n` etc.            |
| `col LIKE '%foo%'`         | `col=like.*foo*`           |
| `col ILIKE '%foo%'`        | `col=ilike.*foo*`          |
| `col IS NULL`              | `col=is.null`              |
| `col IS NOT NULL`          | `col=not.is.null`          |
| `col IN ('a', 'b')`        | `col=in.(a,b)`             |
| Multiple clauses with `AND`| Multiple query params      |

### 2. RPC call

```sql
SELECT function_name(p_arg := value, p_other := value, ...)
```

**Named arguments only.** The tool requires `p_arg := value` syntax. Positional arguments are not supported in v1 because the function parameter names cannot be inferred from the SQL alone.

Argument values support:

- Quoted strings: `'hello'`, `'O''Brien'` (escape `'` as `''`)
- Numbers: `42`, `-5`, `3.14`
- Booleans: `true`, `false`
- Null: `null`, `NULL`
- Arrays: `ARRAY['a', 'b']`, `ARRAY[1, 2]`
- JSONB casts: `'[{"id": 1}]'::jsonb`, `'{"a": 1}'::jsonb`
- Other casts (`::text`, `::uuid`, `::int` etc.) — inner value passes through

---

## Examples

```sql
-- Plain select
SELECT * FROM tickets WHERE status = 'OPEN' LIMIT 10

-- Multiple conditions, ordered
SELECT id, status, title
FROM tickets
WHERE status = 'OPEN' AND type = 'MT'
ORDER BY id DESC
LIMIT 20

-- RPC, no args
SELECT initialise_agent()

-- RPC, named string args
SELECT get_session_init(p_device := 'MOBILE', p_role := 'DEV')

-- RPC, JSONB array
SELECT seed_tickets(p_tickets := '[{"ticket_id":"MT-001","type":"MT","title":"...","description":"...","status":"OPEN","raised_by":"Paul","assigned_team":"Infrastructure"}]'::jsonb)

-- RPC, ARRAY
SELECT get_ticket_contexts(p_ticket_ids := ARRAY['MT-081', 'MT-082'])
```

---

## Output formats

The result panel renders one of four states:

- **Rows** — HTML table with monospace cells. Copy button produces a markdown table.
- **No rows** — `Query executed, no rows returned.`
- **Scalar / object** — JSON, pretty-printed.
- **Error** — Postgres error message, code, hint, details (when present). Distinct red styling.

The Copy button always produces a chat-friendly markdown format (table, code block, or fenced error block) ready to paste back into a conversation.

---

## Out of scope (v1)

- DDL execution — the publishable key + PostgREST does not allow it.
- Multi-statement scripts — PostgREST is single-operation per request.
- Joins, subqueries, CTEs, aggregates, window functions.
- Authenticated user sessions.
- Query history, saved queries, `query_log` table writes (downstream work).
- Positional RPC arguments — use named syntax.

If a query doesn't match a supported pattern, the tool returns a clear parse error explaining what's supported.

---

## Keyboard shortcuts

- **Cmd/Ctrl + Enter** — submit the query.
- **Tab** — insert two spaces (does not move focus out of textarea).

---

## Running parser tests locally

```bash
node test.js
```

51 tests covering parse cases, value casting, WHERE translation, URL building, and markdown rendering. No dependencies — pure stdlib.

---

## Notes

- The previous broken version was a Claude artefact in a chat conversation that scrolled out of reach. This rebuild is deliberately framework-free and host-agnostic so durability never depends on a chat thread again.
- CORS is handled by Supabase by default for the publishable key.
- The textarea uses 16px font on mobile to prevent iOS auto-zoom on focus.
- Clipboard uses `navigator.clipboard` with a `document.execCommand('copy')` fallback.
