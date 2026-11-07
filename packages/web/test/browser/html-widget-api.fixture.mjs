import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { CLIENT_REQUEST_DIAGNOSTIC_HEADER, CLIENT_SENT_AT_DIAGNOSTIC_HEADER } from '@cat-cafe/shared';

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
    '/api/debug/callback-auth': {
      reasonCounts: {},
      toolCounts: {},
      byCat: {},
      recentSamples: [],
      totalFailures: 0,
      startedAt: 0,
      uptimeMs: 0,
      recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader(
      'Access-Control-Allow-Headers',
      ['Content-Type', 'X-Cat-Cafe-User', CLIENT_REQUEST_DIAGNOSTIC_HEADER, CLIENT_SENT_AT_DIAGNOSTIC_HEADER].join(
        ', ',
      ),
    );
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    const body = bodies[pathname];
    response.statusCode = body === undefined ? 404 : 200;
    response.end(JSON.stringify(body ?? { error: 'fixture_route_not_found' }));
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
