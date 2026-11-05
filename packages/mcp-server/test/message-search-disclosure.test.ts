import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { MessageSearchResponse } from '@cat-cafe/shared';
import { boundMessageSearchResponse } from '../../api/src/domains/memory/message-search-budget.js';
import { handleSearchEvidence } from '../src/tools/evidence-tools.js';

let env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch;
beforeEach(() => {
  env = { ...process.env };
  fetch = globalThis.fetch;
  for (const key of [
    'CAT_CAFE_CREDENTIAL_FILE',
    'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
    'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
  ])
    delete process.env[key];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49153';
  process.env.CAT_CAFE_INVOCATION_ID = 'controlled-disclosure';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'controlled-token';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = fetch;
});

const envelope = (qualification?: MessageSearchResponse['meta']['qualification']): MessageSearchResponse => ({
  searchId: 'same-ref',
  query: 'neutral topic',
  results: [],
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: true,
    hasMore: false,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    ...(qualification ? { qualification } : {}),
    response: { budgetChars: 24000, serializedChars: 0, truncated: false, continuation: 'unavailable' },
  },
});

test('the final MCP callback envelope stays parseable JSON with the API explanation first, within 24k and one authenticated request', async () => {
  const body = boundMessageSearchResponse(
    envelope({
      status: 'partial',
      examined: 1651,
      supported: 0,
      rejected: 0,
      indeterminate: 0,
      unassessed: 1651,
      batches: { started: 2, completed: 0, cancelled: 2, failed: 0 },
    }),
  );
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, '/api/callbacks/search-evidence');
    assert.equal((init?.headers as Record<string, string>)['x-invocation-id'], 'controlled-disclosure');
    return { ok: true, json: async () => body } as Response;
  };
  const result = await handleSearchEvidence({ query: 'neutral topic', resultUnit: 'message' });
  assert.equal(calls, 1);
  assert.equal(result.isError, undefined);
  const wire = result.content[0].text;
  const parsed = JSON.parse(wire);
  assert.equal(Object.keys(parsed)[0], 'notice');
  assert.match(parsed.notice.summary, /全部尚未评估.*不能据此判断历史没有/);
  assert.match(parsed.notice.execution, /取消 2/);
  assert.deepEqual(parsed, body);
  assert.ok(wire.length <= 24000);
  assert.equal(parsed.meta.response.serializedChars, wire.length);
});

test('callback errors are still errors, with no invented qualification or retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 503, text: async () => 'message_search_timeout' } as Response;
  };
  const result = await handleSearchEvidence({ query: 'neutral topic', resultUnit: 'message' });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /503/);
  assert.doesNotMatch(result.content[0].text, /全部尚未评估/);
});
