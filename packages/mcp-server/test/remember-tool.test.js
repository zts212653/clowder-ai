import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { handleRemember, rememberTools } from '../dist/tools/remember-tool.js';

const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
let saved, originalFetch, requests;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  originalFetch = globalThis.fetch;
  requests = [];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'remember-test';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'remember-test-token';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      json: async () => ({
        groupId: 'remember-example',
        results: [{ itemId: 'one', statusCode: 422, result: { error: 'source_not_eligible' } }],
      }),
    };
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('remember makes one authenticated callback with original payloads and returns per-item refusals unchanged', async () => {
  const items = [
    {
      itemId: 'one',
      target: 'profile',
      payload: {
        afterContent: '新内容',
        rationale: '主人明确要求',
        targetLayer: 'corpus',
        clientRequestId: 'original-key',
      },
    },
  ];
  const result = await handleRemember({ clientRequestId: 'group-key', items });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/callbacks\/remember$/);
  assert.deepEqual(requests[0].body, { clientRequestId: 'group-key', items });
  assert.equal(requests[0].headers['x-invocation-id'], 'remember-test');
  assert.equal(JSON.parse(result.content[0].text).results[0].result.error, 'source_not_eligible');
});
test('remember is discoverable while every old write tool is retained; schema accepts only one to four rows', async () => {
  const { CANONICAL_TOOL_REGISTRY } = await import('../dist/server-toolsets.js');
  const names = new Set(CANONICAL_TOOL_REGISTRY.map((tool) => tool.name));
  for (const name of [
    'remember',
    'propose_profile_update',
    'propose_taste',
    'propose_person_memory',
    'defer_person_memory_delta',
    'record_proactive_memory_abstention',
    'propose_entity',
    'propose_event_memory_correction',
    'write_memory_matter',
  ])
    assert.ok(names.has(`cat_cafe_${name}`), name);
  const schema = z.object(rememberTools[0].inputSchema),
    item = { itemId: 'one', target: 'taste', payload: {} };
  assert.equal(schema.safeParse({ items: [item] }).success, true);
  assert.equal(schema.safeParse({ items: [] }).success, false);
  assert.equal(schema.safeParse({ items: Array(5).fill(item) }).success, false);
  assert.equal(schema.safeParse({ items: [{ ...item, target: 'forget' }] }).success, false);
});
