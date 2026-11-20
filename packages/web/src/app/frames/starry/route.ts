import document from '!!../../../../scripts/starry-frame-loader.mjs!../../../starry/entry.tsx';

export const dynamic = 'force-static';

export function GET() {
  return new Response(document, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
