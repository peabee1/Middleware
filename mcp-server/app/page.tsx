// Minimal landing page — provides a sanity-check URL when deployed.
// The actual MCP surface is at /api/mcp.

export default function Home() {
  return (
    <main
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        maxWidth: '40rem',
        margin: '0 auto',
        padding: '3rem 1.5rem',
        lineHeight: 1.55,
        color: '#1a1a1a',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>
        Middleware MCP server
      </h1>
      <p style={{ marginTop: 0 }}>
        Bridges Claude.ai chats and Paul&rsquo;s Supabase substrate.
      </p>
      <p>
        MCP endpoint: <code>/api/mcp</code>
      </p>
      <p style={{ color: '#666', fontSize: '0.875rem' }}>
        Status: running.
      </p>
    </main>
  );
}
