import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css'],
  '/surface.mjs': ['surface.mjs', 'text/javascript'],
  '/peer.mjs': ['peer.mjs', 'text/javascript'],
  '/screen-share.mjs': ['screen-share.mjs', 'text/javascript'],
  '/epoch.mjs': ['epoch.mjs', 'text/javascript'],
  '/transcript-view.mjs': ['transcript-view.mjs', 'text/javascript'],
  '/theme.css': ['../../packages/web/src/app/theme-tokens.css', 'text/css'],
  '/pet.webp': ['../../packages/web/public/concierge/skins/yanyan-codex/spritesheet.webp', 'image/webp'],
};
export function startServer(port = 3382) {
  const server = createServer(async (request, response) => {
    const entry = files[request.url];
    if (request.method !== 'GET' || !entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = await readFile(new URL(entry[0], import.meta.url));
      response.writeHead(200, {
        'Content-Type': entry[1],
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'",
      });
      response.end(body);
    } catch {
      response.writeHead(500);
      response.end('Asset unavailable');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
