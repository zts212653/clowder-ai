import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { connectionDiagnosticBatchSchema } from '@cat-cafe/shared';
import { createChatProofApi } from './f322-chat-real-page-data.mjs';

function homeLease(route, url, leases) {
  const request = route.request();
  if (url.pathname === '/api/concierge/home/clients' && request.method() === 'POST') {
    const token = '00000000-0000-4000-8000-000000000001';
    leases.set(request.postDataJSON().clientId, token);
    return route.fulfill({ json: { clientToken: token, expiresAt: Date.now() + 60000 } });
  }
  if (url.pathname.startsWith('/api/concierge/home/clients/') && request.method() === 'DELETE') {
    const clientId = url.pathname.split('/').at(-1);
    assert.equal(request.postDataJSON().clientToken, leases.get(clientId));
    return route.fulfill({ json: { released: leases.delete(clientId) } });
  }
}

// Register before specific fault handlers. Unknown API/upload/Socket.IO requests
// fail closed, including when the production build contains a live proxy URL.
export async function installSetupHttpBoundary(context, evidence, unmodeled) {
  const common = createChatProofApi();
  const leases = new Map();
  const baseline = {
    '/api/config/cat-order': { catOrder: [] },
    '/api/accounts': { projectPath: '/author-native-fixture', providers: [] },
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
    '/api/concierge/desktop': { connected: false },
    '/api/concierge/config': { enabled: false },
    '/api/concierge/thread': { thread: null },
    '/api/threads/default/game': { game: null },
    '/api/threads/default/queue': { queue: [], activeInvocations: [] },
    '/api/approval-hub/pending': { items: [], count: 0 },
  };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!/^\/(api|socket\.io|uploads)(\/|$)/.test(url.pathname)) return route.continue();
    if (request.method() === 'GET' && Object.hasOwn(baseline, url.pathname))
      return route.fulfill({ json: baseline[url.pathname] });
    if (request.method() === 'GET') {
      const response = common.respond(request, url);
      if (response) return route.fulfill(response);
    }
    if (url.pathname === '/api/cats/runtime-models' && request.method() === 'POST')
      return route.fulfill({ json: { status: 'configured', models: [] } });
    if (url.pathname === '/api/diagnostics/connection' && request.method() === 'POST') {
      assert.equal(request.headers()['x-csrf-token'], 'fixture-only');
      const batch = connectionDiagnosticBatchSchema.parse(request.postDataJSON());
      await appendFile(`${evidence}/connection-diagnostics.jsonl`, `${JSON.stringify(batch)}\n`);
      return route.fulfill({ status: 204 });
    }
    const lease = homeLease(route, url, leases);
    if (lease) return lease;
    const item = { method: request.method(), path: url.pathname };
    unmodeled.push(item);
    await appendFile(`${evidence}/unmodeled-api.jsonl`, `${JSON.stringify(item)}\n`);
    return route.fulfill({ status: 503, json: { error: 'Unmodeled isolated HTTP dependency' } });
  });
}

export async function installSetupSocketBoundary(page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const sid = 'native-setup-fixture';
    socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 300000, pingTimeout: 200000 })}`);
    socket.onMessage((packet) => {
      const text = String(packet);
      if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
      if (!text.startsWith('42')) return;
      const bracket = text.indexOf('['),
        ack = text.slice(2, bracket);
      const [event, room] = JSON.parse(text.slice(bracket));
      if (event === 'join_room' && ack) socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
    });
  });
}
