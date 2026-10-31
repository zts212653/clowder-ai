export const dynamic = 'force-dynamic';

export async function GET() {
  await new Promise((resolve) => setTimeout(resolve, 700));
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#ff00ff"/></svg>',
    {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'image/svg+xml',
      },
    },
  );
}
