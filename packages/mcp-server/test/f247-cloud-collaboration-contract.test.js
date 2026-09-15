import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCollabToolset, registerMemoryToolset } from '../dist/server-toolsets.js';

const keys = [
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_AGENT_KEY_SECRET',
  'CAT_CAFE_AGENT_KEY_FILE',
  'CAT_CAFE_AGENT_KEY_FILES',
  'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
  'CAT_CAFE_API_URL',
  'CAT_CAFE_DESKTOP_MODE',
  'CAT_CAFE_READONLY',
];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function cloudClient(t) {
  for (const key of keys) delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), 'f247-cloud-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, 'gpt-pro.secret');
  writeFileSync(keyFile, 'test-cloud-agent', { mode: 0o600 });
  process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'gpt-pro': keyFile });
  process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID = 'gpt-pro';
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49999';
  process.env.CAT_CAFE_DESKTOP_MODE = 'cloud-pro-phase0';
  process.env.CAT_CAFE_READONLY = 'true';
  const server = new McpServer({ name: 'cloud-contract', version: '1' });
  registerCollabToolset(server);
  registerMemoryToolset(server);
  const client = new Client({ name: 'cloud-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('public cloud discovery is callable with an explicit thread and authenticated identity', async (t) => {
  const client = await cloudClient(t);
  const { tools } = await client.listTools();
  const discovery = tools.find((tool) => tool.name === 'cat_cafe_get_thread_cats');
  assert.ok(discovery, 'public cloud profile must expose its recommended discovery tool');
  assert.ok(discovery.inputSchema.required?.includes('threadId'));
  assert.equal(discovery.annotations.readOnlyHint, true);
  assert.match(discovery.description, /not.*online|not.*idle/i);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ threadId: 'owned', routableNow: [{ catId: 'codex-astra' }] }));
  };
  const response = await client.callTool({
    name: discovery.name,
    arguments: { threadId: 'owned', agentKeyCatId: 'gpt-pro' },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(new URL(calls[0].url).pathname, '/api/callbacks/thread-cats');
  assert.equal(new URL(calls[0].url).searchParams.get('threadId'), 'owned');
  assert.equal(new Headers(calls[0].init.headers).get('x-agent-key-secret'), 'test-cloud-agent');
  assert.equal((await client.callTool({ name: discovery.name, arguments: {} })).isError, true);
  assert.equal(calls.length, 1, 'missing thread must fail before transport');
});

test('cloud schema distinguishes root sends from returns and rejects invocation-only fields before transport', async (t) => {
  const client = await cloudClient(t);
  const { tools } = await client.listTools();
  const post = tools.find((tool) => tool.name === 'cat_cafe_post_message');
  const cross = tools.find((tool) => tool.name === 'cat_cafe_cross_post_message');
  const context = tools.find((tool) => tool.name === 'cat_cafe_get_thread_context');
  assert.ok(context.inputSchema.required?.includes('threadId'), 'agent-key context requires a thread');
  for (const tool of [post, cross]) {
    for (const field of ['action', 'proposedAction', 'coordination', 'cloudReturnBinding']) {
      assert.equal(field in tool.inputSchema.properties, false, `${tool.name}.${field}`);
    }
  }
  assert.match(post.description, /proactive|root/i);
  assert.match(post.description, /complete.*answer|final.*answer/i);
  assert.doesNotMatch(post.description, /Do NOT use this for routine replies/i);
  assert.ok(post.inputSchema.properties.localReviewVerdict, 'agent-key review facts remain available');
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: 'ok', messageId: `message-${bodies.length}` }));
  };
  const root = {
    agentKeyCatId: 'gpt-pro',
    threadId: 'owned',
    content: 'Please investigate this issue.',
    targetCats: ['codex-astra'],
  };
  const rootResult = await client.callTool({ name: post.name, arguments: root });
  assert.equal(rootResult.isError, undefined, JSON.stringify(rootResult));
  assert.equal(bodies[0].replyTo, undefined);
  assert.deepEqual(bodies[0].targetCats, ['codex-astra'], 'never add self to explicit recipients');
  assert.equal(
    (await client.callTool({ name: post.name, arguments: { ...root, replyTo: 'exact-source' } })).isError,
    undefined,
  );
  assert.equal(bodies[1].replyTo, 'exact-source');
  for (const extra of [{ action: {} }, { coordination: { phase: 'active' } }, { streamDisposition: 'replace_final' }]) {
    assert.equal((await client.callTool({ name: post.name, arguments: { ...root, ...extra } })).isError, true);
  }
  assert.equal(bodies.length, 2, 'unsupported fields must not be stripped into an ordinary write');
  const crossResult = await client.callTool({ name: cross.name, arguments: { ...root, threadId: 'other-owned' } });
  assert.equal(crossResult.isError, undefined, JSON.stringify(crossResult));
  assert.equal(bodies[2].threadId, 'other-owned');
  assert.equal(bodies[2].replyTo, undefined);
  assert.deepEqual(bodies[2].targetCats, ['codex-astra']);
  for (const extra of [{ proposedAction: {} }, { coordination: { phase: 'active' } }]) {
    assert.equal((await client.callTool({ name: cross.name, arguments: { ...root, ...extra } })).isError, true);
  }
  assert.equal(bodies.length, 3, 'invalid cross-thread transfer must fail before transport');
});
