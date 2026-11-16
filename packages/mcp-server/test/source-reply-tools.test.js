import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { callbackTools, handleCreateRichBlock, handlePostMessage } from '../dist/tools/callback-tools.js';
import { evidenceTools, handleSearchEvidence } from '../dist/tools/evidence-tools.js';

let savedEnv, savedFetch, calls;
const selections = [
  {
    threadId: 'original-thread',
    messageId: 'original-message',
    contentRevision: 'a'.repeat(64),
    quote: '只有原话才能作为出处。',
    reason: '这是当时定下的条件。',
  },
];
beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  calls = [];
  for (const key of [
    'CAT_CAFE_CREDENTIAL_FILE',
    'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
  ])
    delete process.env[key];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49153';
  process.env.CAT_CAFE_INVOCATION_ID = randomUUID();
  process.env.CAT_CAFE_CALLBACK_TOKEN = randomUUID();
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () =>
        path.endsWith('/answer')
          ? { status: 'prepared', publicationRef: 'message-search-answer:' + 'b'.repeat(64) }
          : { status: 'ok', messageId: 'actual-reply' },
    };
  };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});

test('common rich reply prepares selected sources for the original normal-response binding', async () => {
  const result = await handleCreateRichBlock({
    block: JSON.stringify({
      kind: 'sources',
      v: 1,
      id: 'same-answer-purpose',
      query: '当时怎么定的',
      selections,
    }),
  });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/callbacks/search-evidence/answer');
  assert.equal(calls[0].body.operationId, 'same-answer-purpose');
  assert.deepEqual(calls[0].body.selections, selections);
  assert.match(result.content[0].text, /prepared/);
});

test('ordinary explicit reply mechanically prepares then attaches the original reference', async () => {
  const result = await handlePostMessage({
    content: '当时明确保留了条件。',
    clientMessageId: 'same-reply',
    searchAnswer: { query: '当时怎么定的', selections },
  });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(
    calls.map((x) => x.path),
    ['/api/callbacks/search-evidence/answer', '/api/callbacks/post-message'],
  );
  assert.deepEqual(calls[0].body.selections, selections);
  assert.equal(calls[1].body.clientMessageId, 'same-reply');
  assert.deepEqual(calls[1].body.searchAnswer, { publicationRef: 'message-search-answer:' + 'b'.repeat(64) });
  assert.equal(calls[1].body.searchAnswer.selections, undefined);
});

test('source verification rejection cannot fall back into an unverified rich block or send the reply', async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'Source is not quotable' };
  };
  const result = await handleCreateRichBlock({
    block: JSON.stringify({
      kind: 'sources',
      v: 1,
      id: 'denied-purpose',
      query: '原话',
      selections,
    }),
  });
  assert.equal(result.isError, true);
  assert.deepEqual(
    calls.map((x) => x.path),
    ['/api/callbacks/search-evidence/answer'],
  );
  assert.doesNotMatch(result.content[0].text, /cc_rich/);
});

test('agent-key rich-only sources cannot send a query label; an actual post retains the destination and grant', async () => {
  delete process.env.CAT_CAFE_INVOCATION_ID;
  delete process.env.CAT_CAFE_CALLBACK_TOKEN;
  process.env.CAT_CAFE_AGENT_KEY_SECRET = 'isolated-source-reply-test';
  const block = JSON.stringify({
    kind: 'sources',
    v: 1,
    id: 'cloud-purpose',
    query: '当时怎么定的',
    selections,
    replyTo: 'original-granted-question',
  });
  const missing = await handleCreateRichBlock({ block });
  assert.equal(missing.isError, true);
  assert.equal(calls.length, 0);
  const rejected = await handleCreateRichBlock({ block, threadId: 'granted-destination' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /actual answer.*post_message/);
  assert.equal(calls.length, 0);
  const result = await handlePostMessage({
    content: 'The actual answer.',
    threadId: 'granted-destination',
    replyTo: 'original-granted-question',
    clientMessageId: 'cloud-purpose',
    searchAnswer: { query: '当时怎么定的', selections },
  });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(
    calls.map((x) => x.path),
    ['/api/callbacks/search-evidence/answer', '/api/callbacks/post-message'],
  );
  assert.equal(calls[0].body.destinationThreadId, 'granted-destination');
  assert.equal(calls[1].body.threadId, 'granted-destination');
  for (const call of calls) assert.equal(call.body.replyTo, 'original-granted-question');
  assert.equal(calls[1].body.clientMessageId, 'cloud-purpose');
  assert.equal(calls[1].body.content, 'The actual answer.');
});

test('the common reply preserves saved legacy retry identity and bound-card forwarding', async () => {
  const result = await handlePostMessage({
    content: 'Existing answer',
    clientMessageId: 'same-reply',
    searchAnswer: {
      query: 'piano',
      operationId: 'legacy-operation',
      retrievalMode: 'hybrid',
      threadId: 'original-scope',
      limit: 3,
      dateFrom: '2026-01-01',
    },
  });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(calls[0].body, {
    operationId: 'legacy-operation',
    q: 'piano',
    mode: 'hybrid',
    resultUnit: 'message',
    scope: 'threads',
    messageSort: 'time',
    threadId: 'original-scope',
    limit: '3',
    dateFrom: '2026-01-01',
  });
  const forwarding = {
    publicationRef: 'message-search-answer:' + 'b'.repeat(64),
    source: { messageId: 'bound-message', blockId: 'bound-block' },
  };
  await handlePostMessage({ content: 'Forwarded answer', clientMessageId: 'forward-reply', searchAnswer: forwarding });
  assert.equal(calls.length, 3, 'forwarding must not prepare a second publication');
  assert.deepEqual(calls[2].body.searchAnswer, forwarding);
});

test('pending verification and an absent stable reply ID do not dispatch any answer', async () => {
  const input = { content: 'An answer', searchAnswer: { query: 'original', selections } };
  assert.equal((await handlePostMessage(input)).isError, true);
  assert.equal(calls.length, 0);
  globalThis.fetch = async (url) => {
    calls.push({ path: new URL(String(url)).pathname });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending', publicationRef: 'message-search-answer:' + 'b'.repeat(64) }),
    };
  };
  const result = await handlePostMessage({ ...input, clientMessageId: 'stable-answer' });
  assert.equal(result.isError, true);
  assert.deepEqual(
    calls.map((x) => x.path),
    ['/api/callbacks/search-evidence/answer'],
  );
});

test('ordinary recall remains a readonly GET; common reply tools own the declared source-card writes', async () => {
  assert.equal(
    evidenceTools.some((tool) => tool.name === 'cat_cafe_prepare_message_search_answer'), // mcp-cutover-negative-reference: absence
    false,
  );
  assert.equal(evidenceTools.find((tool) => tool.name === 'cat_cafe_search_evidence').annotations.readOnlyHint, true);
  for (const name of ['cat_cafe_create_rich_block', 'cat_cafe_post_message']) {
    const tool = callbackTools.find((tool) => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.policy.runtimeProfiles.includes('readonly'), false);
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  await handleSearchEvidence({ query: 'original', resultUnit: 'message', mode: 'hybrid' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});
