import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserSessionHost } from '../dist/domains/browser/browser-session-host.js';
import { FakeContext } from './helpers/fake-browser-context.js';

const KEY = 'k'.repeat(64);
const WORKSPACE = '/ws/cat-cafe';
const text = (result) => result.content[0].text;

/** Upstream stand-in: same createConnection shape, tools that expose roots and the context getter. */
function stubServer(configs, createDelayMs = 0) {
  return async (config, contextGetter) => {
    configs.push(config);
    // Real createConnection is async; a delay keeps many creations in flight at once.
    if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
    const server = new McpServer({ name: 'stub', version: '0' });
    server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    server.registerTool('roots', { description: 'roots' }, async () => {
      const { roots } = await server.server.listRoots();
      return { content: [{ type: 'text', text: JSON.stringify(roots.map((root) => root.uri)) }] };
    });
    server.registerTool(
      'hang',
      { description: 'never settles, like a stuck run_code_unsafe' },
      () => new Promise(() => {}),
    );
    server.registerTool('open', { description: 'open' }, async () => {
      const context = await contextGetter();
      return { content: [{ type: 'text', text: String(context.pages().length) }] };
    });
    return server;
  };
}

async function harness({ now = () => Date.now(), requestDeadlineMs, createDelayMs } = {}) {
  const configs = [];
  const contexts = [];
  const poisoned = [];
  const makeHost = () =>
    new BrowserSessionHost({
      key: KEY,
      now,
      requestDeadlineMs,
      onPoisoned: () => poisoned.push(Date.now()),
      launch: async () => {
        contexts.push(new FakeContext());
        return contexts.at(-1);
      },
      createServer: stubServer(configs, createDelayMs),
    });
  const current = { host: makeHost() };
  const http = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on(
      'end',
      () => void current.host.handle(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined),
    );
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    current,
    configs,
    contexts,
    poisoned,
    restart: () => (current.host = makeHost()),
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    close: () => http.close(),
  };
}

const identity = (binding, thread = 'thread_a') => ({
  'x-cat-cafe-browser-key': KEY,
  'x-cat-cafe-browser-thread': thread,
  'x-cat-cafe-browser-workspace': WORKSPACE,
  'x-cat-cafe-browser-binding': binding,
});

/** A cat's client: declares roots and would answer them with a different directory. */
async function cat(url, headers, declaredRoot = '/elsewhere') {
  const client = new Client({ name: 'cat', version: '0' }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(declaredRoot).href }],
  }));
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

test('only the API key and complete identity reach the browser; outputs are per thread', async () => {
  const h = await harness();
  try {
    const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const wrongKey = await fetch(h.url, {
      method: 'POST',
      headers: { ...json, ...identity('b'), 'x-cat-cafe-browser-key': 'x' },
      body,
    });
    assert.equal(wrongKey.status, 403);
    const badThread = await fetch(h.url, { method: 'POST', headers: { ...json, ...identity('b', '../etc') }, body });
    assert.equal(badThread.status, 400);
    const client = await cat(h.url, identity('bind-1'));
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong');
    assert.equal(h.configs.at(-1).outputDir, `${WORKSPACE}/.playwright-mcp/thread_a`);
    assert.equal(h.configs.at(-1).sharedBrowserContext, true);
  } finally {
    h.close();
  }
});

test('the verified workspace is the only root Playwright sees, whatever the client declares (R1 P1-1)', async () => {
  const h = await harness();
  try {
    const client = await cat(h.url, identity('bind-1'), '/attacker/chosen');
    const roots = JSON.parse(text(await client.callTool({ name: 'roots', arguments: {} })));
    assert.deepEqual(roots, [pathToFileURL(WORKSPACE).href]);
  } finally {
    h.close();
  }
});

test('the same client keeps working after idle release and after the process restarts (R1 P1-2)', async () => {
  let now = 1_000_000;
  const h = await harness({ now: () => now });
  try {
    const client = await cat(h.url, identity('bind-1'));
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong');
    now += 31 * 60_000;
    await h.current.host.reap();
    assert.equal(h.current.host.sessionCount, 0, 'idle state released');
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong', 'rebuilt on demand');
    h.restart();
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong', 'a fresh process serves it');
  } finally {
    h.close();
  }
});

test("a thread's pages outlive its released state by another idle window (R1 P1-2)", async () => {
  let now = 1_000_000;
  const h = await harness({ now: () => now });
  try {
    const client = await cat(h.url, identity('bind-1'));
    await client.callTool({ name: 'open', arguments: {} });
    const context = h.contexts[0];
    assert.equal(context.list.length, 1, 'the session own page');
    now += 31 * 60_000;
    await h.current.host.reap();
    assert.equal(h.current.host.sessionCount, 0);
    assert.equal(context.list.length, 1, 'kept for the cat to come back');
    now += 29 * 60_000;
    await h.current.host.reap();
    assert.equal(context.list.length, 1);
    now += 2 * 60_000;
    await h.current.host.reap();
    assert.equal(context.list.length, 0, 'closed after the second window');
  } finally {
    h.close();
  }
});

test('beyond the state limit the least recently used idle binding is released', async () => {
  let now = 1_000_000;
  const h = await harness({ now: () => now });
  try {
    const call = (binding) =>
      fetch(h.url, {
        method: 'POST',
        headers: { ...identity(binding), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    for (let i = 0; i < 128; i++) {
      now += 1;
      assert.equal((await call(`bind-${i}`)).status, 200);
    }
    assert.equal(h.current.host.sessionCount, 128);
    now += 1;
    assert.equal((await call('bind-new')).status, 200);
    assert.equal(h.current.host.sessionCount, 128, 'bounded');
  } finally {
    h.close();
  }
});

const post = (url, headers, body) =>
  fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

test('the client version is negotiated and no undeliverable capability is advertised (R2 P1-1)', async () => {
  const h = await harness();
  try {
    const res = await post(h.url, identity('bind-old'), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '0' } },
    });
    const { result } = await res.json();
    assert.equal(result.protocolVersion, '2024-11-05', 'not forced to the newest version');
    assert.equal(result.capabilities.tools.listChanged, false, 'notifications have no way back over a stateless edge');
  } finally {
    h.close();
  }
});

test('concurrent creations cannot exceed the state limit (R2 P1-2)', async () => {
  const h = await harness({ createDelayMs: 20 });
  try {
    const statuses = await Promise.all(
      Array.from({ length: 140 }, (_, i) =>
        post(h.url, identity(`bind-${i}`), { jsonrpc: '2.0', id: 1, method: 'tools/list' }).then((r) => r.status),
      ),
    );
    assert.ok(h.current.host.sessionCount <= 128, `sessionCount=${h.current.host.sessionCount}`);
    assert.ok(statuses.every((status) => status === 200 || status === 503));
  } finally {
    h.close();
  }
});

test('a call that never settles fails once; the process is retired and the next generation serves (R2 P1-3, R3)', async () => {
  const h = await harness({ requestDeadlineMs: 100 });
  try {
    const client = await cat(h.url, identity('bind-1'));
    const other = await cat(h.url, identity('bind-2', 'thread_b'));
    const hung = await client.callTool({ name: 'hang', arguments: {} }).catch((error) => ({ error }));
    assert.match(String(hung.error?.message ?? JSON.stringify(hung)), /did not finish in time/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.poisoned.length, 1, 'the owner is told once to end this process');
    // The late call is still running in here, so this process serves nobody any more.
    await assert.rejects(other.callTool({ name: 'ping', arguments: {} }), /503|browser_restarting/);
    h.restart(); // the API forks the next generation
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong', 'rebuilt, not replayed');
    assert.equal(text(await other.callTool({ name: 'ping', arguments: {} })), 'pong');
  } finally {
    h.close();
  }
});

test('a process that is closing for any reason refuses new work instead of relaunching Chrome (R3 sweep)', async () => {
  const h = await harness();
  try {
    const client = await cat(h.url, identity('bind-1'));
    assert.equal(text(await client.callTool({ name: 'ping', arguments: {} })), 'pong');
    h.current.host.stopServing(); // idle exit or lost IPC: the entry calls this before closing
    const res = await post(h.url, identity('bind-2'), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'browser_restarting');
    assert.equal(h.contexts.length, 0, 'no browser was launched for it');
  } finally {
    h.close();
  }
});
