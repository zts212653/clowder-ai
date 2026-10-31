import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css'],
  '/conversation.css': ['conversation.css', 'text/css'],
  '/surface.mjs': ['surface.mjs', 'text/javascript'],
  '/state.mjs': ['state.mjs', 'text/javascript'],
  '/theme.css': ['../../packages/web/src/app/theme-tokens.css', 'text/css'],
  '/pet.webp': ['../../packages/web/public/concierge/skins/yanyan-codex/spritesheet.webp', 'image/webp'],
};

export function startServer(port = 3381) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const entry = assets[pathname];
    if (!entry || request.method !== 'GET') {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(fileURLToPath(new URL(entry[0], import.meta.url)));
      response.writeHead(200, {
        'Content-Type': entry[1],
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'self'; object-src 'none'",
      });
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end('Design asset unavailable');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
