import { notFound } from 'next/navigation';

/** Synthetic bootstrap for the isolated design server. No Host proxy or user data. */
export async function GET() {
  if (process.env.NODE_ENV === 'production' || process.env.SUPERAGENT_PREVIEW_FIXTURES !== '1') notFound();
  return Response.json(
    { userId: 'superagent-design-preview', csrfToken: 'synthetic-preview-only' },
    { headers: { 'Cache-Control': 'no-store', 'X-Superagent-Preview': 'synthetic' } },
  );
}
