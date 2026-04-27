# SQL Query Tool — Architectural Baseline

| Field | Value |
|---|---|
| **Document type** | Architectural baseline (constitutional document) |
| **Owner** | Dev |
| **Audience** | Future Dev sessions (primary); Senior, Paul, Executive (reference) |
| **Status** | Initial draft, capturing the reasoning from the foundational architectural conversation |
| **Change discipline** | Updated by Dev when architectural commitments change. Not amended for v-N feature additions unless the commitment shape changes. |

---

## 1. Purpose of this document

This is the constitutional document for the SQL Query Tool. It captures the long-term goals the tool serves, the architectural commitments those goals imply, and the reasoning behind both. Future Dev sessions read this before producing any proposals so the same ground isn't re-litigated and the same reasoning isn't lost.

It is not a specification — specifications are derived from this baseline for specific versions. It is not exhaustive — many craft decisions remain open within the commitments below. It is the floor everything else stands on.

---

## 2. Current state

The tool exists as a vanilla HTML/CSS/JS web app deployed on Vercel, calling the Supabase project `lkjskaygaijyelfqwoln` directly via PostgREST using the publishable key with RLS enforcement.

v1.0 deployed: SELECT-FROM-table and SELECT-fn(named-args) RPC support, parser handling jsonb casts and ARRAY values, error rendering with code/hint/details, auto-clipboard fill on every result via the ClipboardItem+Promise pattern preserving user-gesture activation across async fetch.

v1.1 deployed: JSON output replacing markdown for all result types, chunking at 14,000 characters with prev/next nav and Copy-current/Copy-next buttons, Clear button with AbortController-based query cancellation, syntax-highlighted JSON viewer.

v1.2 in-flight: blocked pending the architectural shift this baseline represents. Five problems carried forward from the v1.2 spec — positional RPC mismatch, named-syntax UX, multi-query, reversibility, audit-history shape — are now reframed as five of the six goals below, plus their integrated solution.

---

## 3. Long-term goals

The tool exists to serve six goals. Every architectural commitment in §4, every feature in any v-N, and every craft decision either serves these goals or earns its place by being trivially cheap.

**3.1 Trustworthy substrate.** The tool is the project's defence against silent failure. Every SQL request and response is captured durably and append-only. When the database lies — as in MT-265 (CHG-129 silently overwritten) and NOTE-004 (verification reported SUCCESS while initialise_agent was broken) — the audit doesn't.

**3.2 Verbatim parity.** What the agent asks the tool to send is what the tool sends. Translation between input forms is a measured failure mode, not a feature. The rate at which translation happens trends toward zero by changing what the project teaches, not by making the tool smarter at translation.

**3.3 Semantic legibility.** Every SQL submission carries enough structured context that what was intended is recoverable from the audit alone, without point-in-time database reconstruction. Named parameters everywhere possible. Intent travelling alongside the SQL.

**3.4 Friction collapse.** The tool replaces twelve clicks with one paste. Multi-statement workflows don't serialise through Paul's attention. Recoverable state means a small edit doesn't destroy work in progress. Paul holds strategy, not mechanics.

**3.5 Self-instrumenting evolution.** The tool produces the data the project needs to improve itself — which SPs to migrate to named, which agents skip context, where translation happens, where the workflow still leaks attention. The tool is the project's instrument for understanding its own SQL surface.

**3.6 Recoverable failure.** Every failure routes to its right resolver. Tool faults — translation bugs, parser slips, transmission glitches — are fixed inside the tool and the query re-runs without burdening the user, with the audit deciding whether re-run is safe. User errors surface diagnostic information rich enough to fix and resubmit in one cycle. Failure is a fast loop, not an attention sink.

---

## 4. Architectural commitments

These are the load-bearing structural decisions. They constrain every v-N. They change only by deliberate revision of this baseline, not by drift.

### 4.1 SP-centric execution

There is exactly one path that executes SQL: a stored procedure (working name `public.submit_sql(envelope jsonb)`) that handles audit logging, parsing, translation if needed, execution, and result audit logging in a single coordinated call.

The frontend tool does not call PostgREST tables or functions directly. It builds an envelope and posts it to the SP. Future clients — an MCP server, a CLI, a different web frontend — submit through the same SP and inherit identical audit, translation, and verbatim measurement automatically.

The reasoning: audit-as-side-effect is bypassable, even by accident. Audit-as-the-only-execution-path is structurally enforced. This is the same pattern as treating storage as the only durable layer rather than caches: the layer that must always be true must be the layer that's structurally impossible to skip. MT-265 and NOTE-004 are evidence that "always remember to log" is not a sufficient guarantee.

### 4.2 Separate audit project, hash chain over rows

The audit substrate lives in a separate Supabase project from the main project. Different `*.supabase.co` URL, different service-role key, different surface. The main project's `submit_sql` SP makes an HTTPS call to the audit project's REST endpoint to log — the only path data enters the audit. This requires a synchronous HTTPS-capable extension on the main project. v1.2 substrate uses the `http` extension (libcurl-based, synchronous-in-transaction). `pg_net` was evaluated during build and rejected because synchronous-wait-after-async-queue-inside-one-function is structurally deadlocked: the SP cannot commit until it returns, the worker cannot process the queued request until the SP commits, and the synchronous collector polls indefinitely. Future transport choices that preserve synchronous-in-transaction semantics and HTTPS to the audit project's REST endpoint are equivalent for §4.2's purposes.

Each audit row contains a hash of (previous row's hash + this row's content), computed in a BEFORE INSERT trigger. Mutation anywhere in the chain breaks subsequent hashes, making tampering detectable even if access controls were somehow circumvented.

The reasoning: same-DB audit is too risky for the substrate-failure class of concerns the audit exists to defend against. Append-only triggers and role grants are fences against accidents. They are not walls against an agent operating in the main project that wants to corrupt the record, or against a future bug that does it unintentionally. The audit must be the source of truth precisely when something has gone wrong, including when an agent or a privileged operation is what went wrong.

The accepted costs: two Supabase projects to maintain, 50-200ms latency per submission for the cross-project call (substrate-build-1 measured 652ms cold and 400ms warm; revisit if persistently above the upper bound), and an availability tradeoff — if the audit-project write fails, the main-project execution is refused. Refuse-without-auditing is the correct default; trust matters more than availability for this tool. Paul can override this default if the cost surfaces in practice.

### 4.3 Append-only enforcement

The audit tables enforce append-only via BEFORE DELETE and BEFORE UPDATE triggers that raise exceptions. Same enforcement pattern as `schema_scripts` from SES-003. Applied at both the audit-project layer (within the audit DB) and reinforced by the cross-project credential isolation in §4.2.

No UPDATE on existing rows. No DELETE. New rows only. Schema migrations on the audit tables are themselves audited via a meta-mechanism to be specified in the implementing v-N.

### 4.4 Envelope-with-fallback input model

The canonical input shape is a JSON envelope: `{sql, context, ...}`. Submissions can also be naked SQL, in which case the tool auto-wraps with `context: null` and records this in a `wrapped-from-naked` audit field. The naked-SQL fallback exists because mobile ad-hoc queries shouldn't require JSON ceremony; the audit field exists because the missing-context rate is itself a useful KPI for project-level decisions about which agents to update.

Required envelope fields for v1.2: `sql`, `context`. Other fields (session_id, ticket_id, intent_category, expected_kind, idempotency_key) are anticipated but deferred — added as the project's needs surface, without schema migration because the envelope is stored as `jsonb`.

The reasoning: SQL-as-string is too naked. The agent's intent should travel alongside the SQL itself in a structured form the audit can record verbatim. Two diagnostic gaps emerge — the linguistic gap (requested vs sent, captured by the verbatim flag) and the semantic gap (intent vs SQL, captured by context). Both independently valuable.

### 4.5 Named-everywhere as default; translation as measured failure

The audit's "SQL actually sent" field stores named-parameter form, regardless of what the input was. When input is positional, the tool translates to named before sending and records `verbatim=false`. When input is already named or doesn't apply (plain SELECT), translation is a no-op and `verbatim=true`.

This rules out a class of solutions: any design where the tool accepts positional and forwards positional unchanged. The audit must be self-decoding without point-in-time signature reconstruction.

The verbatim flag is measurement infrastructure, not enforcement infrastructure. The tool keeps accepting whatever comes in. The audit produces evidence the project can use to decide which SPs to migrate to named-canonical at the catalogue level. Goal is full parity over time — not by making the tool refuse positional, but by changing what the project teaches so positional stops arriving.

The translation mechanism itself uses a parameter-signature lookup. The implementing v-N specifies where the lookup lives (a `public.get_function_params` SP wrapper, or equivalent). Translation bug risk is acceptable because translation bugs surface in the audit as divergence — the same incorruptibility argument that justifies the audit existing at all.

### 4.6 MCP-readiness as deferred-but-anticipated extension

The current paste-via-Paul transport is the bottleneck the chunking workaround papers over. The real fix is eliminating the paste path entirely — agents calling the tool directly via MCP rather than asking Paul to call the tool on their behalf.

v1.2 does not implement an MCP server. v1.2 architects so the MCP server drops in as a small follow-up, not a rebuild. The mechanism: any future MCP server submits envelopes to the same `submit_sql` SP and inherits all audit, translation, and verbatim properties automatically.

Risky operations — writes, DROPs, TRUNCATEs, anything matching configurable danger patterns — route through a confirmation step the MCP server enforces, gating on Paul. Routine reads execute autonomously. Trust model becomes "audit-everything, human-on-the-loop for risky" rather than "human-in-the-loop for everything".

This commitment shapes v1.2 in concrete ways: the SP signature must be MCP-callable (envelope-in, structured-result-out, no UI assumptions); the audit fields must include enough context that audit entries from MCP and from the textarea tool are indistinguishable in shape; the result format must be the tool's render concern, not the SP's.

---

## 5. What's settled and what's open

**Settled** (all of §4): SP-centric execution, separate audit project, hash chain, append-only, envelope-with-fallback, named-everywhere with measurement, MCP-readiness as deferred concern.

**Open** (decided by implementing v-N): exact SP signature; exact audit table schema beyond the four required §2.2 fields plus the verbatim and context-present flags; reporting layer surface (RPC vs view vs UI panel); UI shape for textarea, audit browser, result panel, multi-query rendering; reversibility mechanism (in-memory stack vs audit-query); error display detail.

**Out of scope** for the tool entirely: schema-qualified table names beyond `public`; non-publishable-key authentication; running SQL outside the project's Supabase database. These may become in-scope via deliberate baseline revision, not by drift.

---

## 6. Anticipated extensions

Mentioned for context. Not commitments. Implementation depends on the implementing v-N.

**Idempotency keys.** Envelope carries a UUID generated client-side. The SP checks audit before executing — if it sees a prior submission with the same key, returns the prior result instead of re-executing. Solves the "network blip after database mutated" double-write risk. Cheap if the audit lookup is indexed on the key.

**Expectation flags.** Envelope optionally carries `expected_kind` ("rows" / "no_rows" / "scalar" / "error"). Audit records when expectation is violated. Becomes a third diagnostic axis alongside verbatim and context-presence.

**Migration suggestions.** When positional comes in and translation happens, the SP writes a row to a `migration_suggestions` table — "this SP got called positionally on this date, consider promoting the named example in sp_reference." Not auto-acting on the catalogue, just nudges for periodic review.

**External audit export.** Periodic export of audit data to truly external storage (GitHub repo, S3 with Object Lock, anything write-once-read-many) so even Supabase isn't the final source of truth. v1.3+ work.

**MCP server.** Per §4.6. Becomes the primary client, with the textarea tool as the secondary one for ad-hoc queries.

---

## 7. How to use this document

A future Dev session reading this should:

Treat §3 as the goals the tool serves. New features earn their place by serving them.

Treat §4 as commitments — change them only by revising this document deliberately, with reasoning, in consultation with Paul.

Treat §5 as the clear distinction between what's locked and what's the implementing v-N's call. The implementing v-N has full latitude on the open items, constrained only by §4.

Treat §6 as planning context — these are the things the architecture is built to accommodate without rebuild. If a v-N proposes one of them, the design lift is small. If a v-N proposes something not in §6, it's worth a baseline-revision conversation first.

Treat the document as living. If a session learns something that shifts the architecture, the document gets revised, not worked around.

---

*End of architectural baseline.*
