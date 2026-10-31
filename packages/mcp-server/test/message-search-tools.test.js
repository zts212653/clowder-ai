import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('MCP message search mode', () => {
  let previousEnv;
  let previousFetch;
  let call;
  const data = { searchId: 'query-ref', query: 'piano', results: [], meta: { partial: true, freshness: 'unknown' } };

  beforeEach(() => {
    previousEnv = { ...process.env };
    previousFetch = globalThis.fetch;
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49153';
    process.env.CAT_CAFE_INVOCATION_ID = 'message-search-test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'message-search-test-token';
    process.env.CAT_CAFE_USER_ID = 'untrusted-environment-user';
    call = undefined;
    globalThis.fetch = async (url, init) => {
      call = { url: new URL(String(url)), init };
      return { ok: true, json: async () => data };
    };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    globalThis.fetch = previousFetch;
  });

  it('uses invocation authentication and the same time/scope/mode request, without caller identity headers', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    const result = await handleSearchEvidence({
      query: 'piano',
      resultUnit: 'message',
      messageSort: 'time',
      scope: 'threads',
      threadId: 'current-thread',
      mode: 'hybrid',
      limit: 3,
    });
    assert.equal(call.url.pathname, '/api/callbacks/search-evidence');
    assert.equal(call.url.searchParams.get('q'), 'piano');
    assert.equal(call.url.searchParams.get('resultUnit'), 'message');
    assert.equal(call.url.searchParams.get('messageSort'), 'time');
    assert.equal(call.url.searchParams.get('threadId'), 'current-thread');
    assert.equal(call.init.headers['x-invocation-id'], 'message-search-test-inv');
    assert.equal(call.init.headers['x-callback-token'], 'message-search-test-token');
    assert.equal(call.init.headers['x-cat-cafe-user'], undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), data);
  });

  it('represents global message scope by threads without a thread ID', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    await handleSearchEvidence({ query: 'piano', resultUnit: 'message', messageSort: 'relevance', mode: 'semantic' });
    assert.equal(call.url.searchParams.get('scope'), 'threads');
    assert.equal(call.url.searchParams.has('threadId'), false);
    assert.equal(call.url.searchParams.get('mode'), 'semantic');
    assert.equal(call.url.searchParams.get('messageSort'), 'relevance');
  });

  it('keeps optional mode, exact strategies and the two documented defaults', async () => {
    const { evidenceTools, handleSearchEvidence, searchEvidenceInputSchema } = await import(
      '../dist/tools/evidence-tools.js'
    );
    const { z } = await import('zod');
    const schema = z.object(searchEvidenceInputSchema);
    assert.equal(schema.safeParse({ query: 'piano' }).success, true);
    assert.equal(schema.safeParse({ query: 'piano', mode: 'delete' }).success, false);
    assert.deepEqual(evidenceTools[0].actionInventory, ['read']);
    assert.deepEqual(evidenceTools[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    await handleSearchEvidence({ query: 'piano' });
    assert.equal(call.url.pathname, '/api/evidence/search');
    assert.equal(call.url.searchParams.has('mode'), false, 'document omission preserves the API lexical default');
    assert.equal(call.url.searchParams.has('resultUnit'), false, 'document requests cannot become message reads');
    await handleSearchEvidence({ query: 'piano', resultUnit: 'message' });
    assert.equal(call.url.searchParams.get('mode'), 'hybrid');
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
      assert.equal(schema.safeParse({ query: 'piano', mode }).success, true);
      await handleSearchEvidence({ query: 'piano', mode });
      assert.equal(call.url.pathname, '/api/evidence/search');
      assert.equal(call.url.searchParams.get('mode'), mode);
      await handleSearchEvidence({ query: 'piano', mode, resultUnit: 'message' });
      assert.equal(call.url.pathname, '/api/callbacks/search-evidence');
      assert.equal(call.url.searchParams.get('mode'), mode);
      assert.equal(call.init.headers['x-invocation-id'], 'message-search-test-inv');
    }
  });

  it('uses verified agent-key transport without environment user or source identity', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'message-search-agent-key-test';
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');
    await handleSearchEvidence({ query: 'piano', resultUnit: 'message', threadId: 'visible' });
    assert.equal(call.url.pathname, '/api/callbacks/search-evidence');
    assert.equal(call.init.headers['x-agent-key-secret'], 'message-search-agent-key-test');
    assert.equal(call.init.headers['x-cat-cafe-user'], undefined);
    assert.equal(call.url.searchParams.has('sourceMessageId'), false);
    assert.equal(call.url.searchParams.has('userId'), false);
  });
});
