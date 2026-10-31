import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../../packages/api/test/fixtures/f317-page-action.html', import.meta.url));

export async function startFixtureServer(port = 0) {
  const html = await readFile(fixture);
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Fixture server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? '5227');
  const started = await startFixtureServer(port);
  console.log(`F317 Page Action Lab: ${started.url}`);
}
