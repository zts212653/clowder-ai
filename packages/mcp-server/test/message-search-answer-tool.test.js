import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { handlePostMessage } from '../dist/tools/callback-tools.js';
import { evidenceTools, handleSearchEvidence } from '../dist/tools/evidence-tools.js';
import { handlePrepareMessageSearchAnswer } from '../dist/tools/message-search-answer-tool.js';

let savedEnv, savedFetch, calls;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  calls = [];
  for (const name of [
    'CAT_CAFE_CREDENTIAL_FILE',
    'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
  ])
    delete process.env[name];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49153';
  process.env.CAT_CAFE_INVOCATION_ID = randomUUID();
  process.env.CAT_CAFE_CALLBACK_TOKEN = randomUUID();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return { ok: true, status: 200, json: async () => ({ status: 'prepared', publicationRef: 'prepared-reference' }) };
  };
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});
test('one declared-write tool submits cat selections while ordinary recall stays a readonly GET', async () => {
  const read = evidenceTools.find((tool) => tool.name === 'cat_cafe_search_evidence');
  const write = evidenceTools.find((tool) => tool.name === 'cat_cafe_prepare_message_search_answer');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(write.policy.runtimeProfiles.includes('readonly'), false);
  assert.match(write.description, /Prepared is not published/);
  await handleSearchEvidence({
    query: '一行',
    resultUnit: 'message',
    threadId: 'sources',
    mode: 'hybrid',
    messageSort: 'time',
    limit: 3,
  });
  assert.equal(calls[0].init.method ?? 'GET', 'GET');
  await handlePrepareMessageSearchAnswer({
    query: '一行',
    operationId: 'one-purpose',
    selections: [
      {
        threadId: 'sources',
        messageId: 'original',
        contentRevision: 'a'.repeat(64),
        quote: '一行',
        reason: 'Chosen from the original.',
      },
    ],
    threadId: 'sources',
    destinationThreadId: 'answer-target',
    retrievalMode: 'hybrid',
    messageSort: 'time',
    limit: 3,
  });
  const request = calls[1];
  assert.equal(request.init.method, 'POST');
  assert.equal(request.url.pathname, '/api/callbacks/search-evidence/answer');
  const body = JSON.parse(request.init.body);
  assert.equal(body.threadId, 'sources');
  assert.equal(body.destinationThreadId, 'answer-target');
  for (const name of ['q', 'threadId', 'mode', 'messageSort', 'limit', 'resultUnit'])
    assert.equal(String(body[name]), calls[0].url.searchParams.get(name));
  assert.equal(body.operationId, 'one-purpose');
  assert.equal(body.selections[0].quote, '一行');
  assert.equal(body.userId, undefined);
});
test('answer preparation does not retry a failed POST or enqueue a hidden second search', async () => {
  globalThis.fetch = async () => {
    calls.push({});
    return { ok: false, status: 503, statusText: 'unavailable', text: async () => 'unavailable' };
  };
  await handlePrepareMessageSearchAnswer({ query: '一行', operationId: 'same-operation' });
  assert.equal(calls.length, 1);
});
test('ordinary default changes do not alter the legacy answer retry identity when sort was omitted', async () => {
  await handlePrepareMessageSearchAnswer({ query: 'piano', operationId: 'saved-legacy' });
  assert.equal(JSON.parse(calls[0].init.body).messageSort, 'time');
});
test('chosen sources cross the declared write boundary without caller-supplied publisher authority', async () => {
  const write = evidenceTools.find((tool) => tool.name === 'cat_cafe_prepare_message_search_answer');
  const selections = [
    {
      threadId: 'original',
      messageId: 'message',
      contentRevision: 'a'.repeat(64),
      quote: 'Only if tests pass.',
      reason: 'A conditional suggestion.',
    },
  ];
  assert.equal(write.inputSchema.selections.safeParse(selections).success, true);
  assert.equal(write.inputSchema.selections.safeParse([{ ...selections[0], author: 'user' }]).success, false);
  assert.equal(write.inputSchema.selections.safeParse([selections[0], selections[0]]).success, false);
  await handlePrepareMessageSearchAnswer({ query: 'decision', operationId: 'selected-purpose', selections });
  assert.deepEqual(JSON.parse(calls[0].init.body).selections, selections);
  assert.match(write.description, /without another search or generative judge/);
  assert.match(write.description, /your judgment, not system-certified support/);
});
test('answer preparation requires selected originals while preserving the identity of saved-operation retries', () => {
  const read = evidenceTools.find((tool) => tool.name === 'cat_cafe_search_evidence');
  const write = evidenceTools.find((tool) => tool.name === 'cat_cafe_prepare_message_search_answer');
  assert.match(read.inputSchema.messageSort.description, /first 32 admitted relevance sources/);
  assert.doesNotMatch(read.description, /legacy qualified mode is transitional/i);
  assert.match(read.description, /New cards require selections/);
  assert.match(read.description, /Only saved legacy query-only operations accept retries without selections/);
  assert.doesNotMatch(write.inputSchema.messageSort.description, /first 32|32.*window/);
  assert.match(write.inputSchema.messageSort.description, /request identity.*retries/);
  assert.match(write.description, /New cards require selections/);
  assert.match(write.inputSchema.selections.description, /Required for a new card/);
  assert.match(write.inputSchema.selections.description, /legacy query-only/);
  assert.match(write.description, /same operationId and original arguments/);
  assert.doesNotMatch(write.description, /Host-qualified subset|legacy search policy|During migration/);
  assert.doesNotMatch(write.description, /same bounded message result|same decided-table card/);
});
test('explicit replies carry only a reference and require the original stable message identity', async () => {
  const searchAnswer = { publicationRef: `message-search-answer:${'a'.repeat(64)}` };
  await handlePostMessage({ content: 'Original answer', searchAnswer });
  assert.equal(calls.length, 0);
  await handlePostMessage({ content: 'Original answer', searchAnswer, clientMessageId: 'same-answer-message' });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body).searchAnswer, searchAnswer);
});
