import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

/** Keep shell/bootstrap requests out of the real runtime during widget tests. */
export async function startHtmlWidgetFixtureApi() {
  const bodies = {
    '/api/session': { ok: true, userId: 'browser-test-user' },
    '/api/cats': { cats: [] },
    '/api/threads': { threads: [] },
    '/api/tasks': { tasks: [] },
    '/api/config/env-summary': { variables: [] },
    '/api/config/cat-order': { catOrder: [] },
    '/api/bootcamp/threads': { threads: [] },
  };
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cat-Cafe-User');
    response.setHeader('Content-Type', 'application/json');
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    response.end(JSON.stringify(bodies[pathname] ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
