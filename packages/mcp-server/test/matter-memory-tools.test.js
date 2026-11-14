import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';

const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
let saved, originalFetch, requests;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  originalFetch = globalThis.fetch;
  requests = [];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'matter-test';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'matter-test-token';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(options.body) : undefined,
    });
    return { ok: true, json: async () => ({ items: [], status: 'test' }) };
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
test('matter tools carry source selections and exact retries through the shared callback routes', async () => {
  const { matterMemoryTools, handleListMemoryMatters, handleReadMemoryMatter } = await import(
    '../dist/tools/matter-memory-tools.js'
  );
  await handleListMemoryMatters({ query: '设置入口', cursor: 'next-page', limit: 2 });
  await handleReadMemoryMatter({ matterId: 'matter/one', cursor: 'entry-page', limit: 3, history: true });
  const change = {
    operation: 'create',
    requestId: 'exact-create',
    title: 'Settings',
    description: '',
    sources: [{ threadId: 'a', messageId: 'm', segment: 'body', start: 0, end: 4, quote: 'text' }],
  };
  const { handleRemember, rememberTools } = await import('../dist/tools/remember-tool.js');
  await handleRemember({ items: [{ itemId: 'matter', target: 'matter', payload: change }] });
  assert.equal(new URL(requests[0].url).searchParams.get('query'), '设置入口');
  assert.equal(new URL(requests[0].url).searchParams.get('cursor'), 'next-page');
  assert.match(requests[1].url, /memory-matters\/matter%2Fone\?/);
  assert.equal(new URL(requests[1].url).searchParams.get('history'), 'true');
  assert.deepEqual(requests[2].body.items[0].payload, change);
  const payload = z
    .object(rememberTools[0].inputSchema)
    .shape.items.element.options.find((item) => item.shape.target.value === 'matter').shape.payload;
  assert.equal(payload.safeParse({ ...change, ownerUserId: 'foreign' }).success, false);
  assert.equal(
    payload.safeParse({ operation: 'forget', requestId: 'forget', matterId: 'one', expectedRevision: 1 }).success,
    false,
  );
});

test('canonical matter descriptions distinguish contextual interpretation, exact speech and a real read', async () => {
  const { matterMemoryTools } = await import('../dist/tools/matter-memory-tools.js');
  const read = matterMemoryTools.find((tool) => tool.name === 'cat_cafe_read_memory_matter');
  const { rememberTools } = await import('../dist/tools/remember-tool.js');
  const description = z
    .object(rememberTools[0].inputSchema)
    .shape.items.element.options.find((item) => item.shape.target.value === 'matter').shape.payload.description;
  assert.match(read.description, /description.*contextual interpretation/i);
  assert.match(read.description, /raw quotes/i);
  assert.match(read.description, /changed.*interpretation.*unverified/i);
  assert.match(read.description, /Directory.*do not count/i);
  assert.match(description, /description is optional cat-written context and applicability/i);
  assert.match(description, /exact original/i);
  assert.match(description, /raw UTF-16/i);
});
