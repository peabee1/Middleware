// Root layout. Next.js App Router requires this even for API-only apps.

export const metadata = {
  title: 'Middleware MCP',
  description:
    "MCP server bridging Claude.ai chats and Paul's Supabase substrate.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
