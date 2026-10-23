import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let originalEnv;
let originalFetch;

beforeEach(() => {
  originalEnv = { ...process.env };
  originalFetch = globalThis.fetch;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3999';
  process.env.CAT_CAFE_INVOCATION_ID = 'inv-pending-decisions';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-pending-decisions';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  globalThis.fetch = originalFetch;
});

test('pending decisions requests the partial-safe unified owner projection', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({ status: 'partial', items: [], sources: {} });
  };
  const module = await import(`../dist/tools/callback-tools.js?partial-view=${Date.now()}`);

  const result = await module.handleGetPendingDecisions({ offset: 2, limit: 5 });

  assert.equal(result.isError, undefined);
  assert.ok(requestedUrl);
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, '/api/callbacks/companion/decisions');
  assert.equal(url.searchParams.get('offset'), '2');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('view'), 'unified');

  const tool = module.callbackTools.find((candidate) => candidate.name === 'cat_cafe_get_pending_decisions');
  assert.ok(tool);
  assert.match(tool.description, /partial/i);
  assert.match(tool.description, /NOT for:/);
  assert.match(tool.description, /Output:/);
});
