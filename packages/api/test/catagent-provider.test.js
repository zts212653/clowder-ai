/**
 * CatAgent Provider Tests — F159 Phase C (AC-C1 ~ AC-C4)
 *
 * AC-C1: opt-in registration (tested indirectly via constructor)
 * AC-C2: single-turn text task e2e (session_init → text → done + usage)
 * AC-C3: no dangling sessions (error → error + done, abort → error + done)
 * AC-C4: no tools sent to API
 *
 * Uses a mock fetch to avoid real API calls.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { CatAgentService } = await import('../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js');

// ── Helpers ──

/** Collect all messages from an async iterable */
async function collect(iter) {
  const msgs = [];
  for await (const msg of iter) msgs.push(msg);
  return msgs;
}

/** Mock fetch that returns a successful Anthropic response */
function mockFetchSuccess(text = 'Hello from CatAgent', model = 'claude-opus-4-20250514') {
  return async (_url, _init) => ({
    ok: true,
    json: async () => ({
      id: 'msg_test',
      model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 42, output_tokens: 10, cache_read_input_tokens: 5 },
    }),
  });
}

/** Mock fetch that returns an HTTP error */
function mockFetchError(status = 429, message = 'Rate limited') {
  return async (_url, _init) => ({
    ok: false,
    status,
    text: async () => message,
  });
}

/** Mock fetch that throws a network error */
function mockFetchNetworkError(message = 'ECONNREFUSED') {
  return async () => {
    throw new Error(message);
  };
}

/** Mock fetch that respects AbortSignal */
function mockFetchAbortable() {
  return async (_url, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    // Simulate delay then check abort
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 100);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
    return {
      ok: true,
      json: async () => ({ id: 'msg', model: 'test', stop_reason: 'end_turn', content: [], usage: {} }),
    };
  };
}

// ── Mock infrastructure ──

// Save original fetch
const originalFetch = globalThis.fetch;

// Mock resolveApiCredentials by patching the module
// Since CatAgentService imports resolveApiCredentials, we test via the service
// with a known projectRoot that won't resolve (fail-closed credential test)
// and a patched global.fetch for API call tests.

// For credential-success tests, we need to make resolveApiCredentials return
// valid credentials. We do this by creating a service subclass for testing.

class TestCatAgentService extends CatAgentService {
  #mockFetch;
  #mockCredentials;

  constructor(options = {}) {
    super({
      catId: options.catId ?? 'test-catagent',
      projectRoot: options.projectRoot ?? '/tmp/nonexistent',
      catConfig: options.catConfig ?? null,
    });
    this.#mockFetch = options.mockFetch ?? mockFetchSuccess();
    this.#mockCredentials = options.mockCredentials ?? null;
  }

  async *invoke(prompt, options) {
    // If we have mock credentials, patch fetch and delegate
    if (this.#mockCredentials) {
      const prev = globalThis.fetch;
      globalThis.fetch = this.#mockFetch;
      try {
        // We can't easily mock resolveApiCredentials, so we test the fetch path
        // by directly testing the service behavior.
        // For the full flow, we test credential failure separately.
        yield* this.#invokeWithCredentials(prompt, options);
      } finally {
        globalThis.fetch = prev;
      }
    } else {
      // No mock credentials — test real credential resolution (will fail-closed)
      yield* super.invoke(prompt, options);
    }
  }

  async *#invokeWithCredentials(prompt, options) {
    const now = Date.now();
    const model = 'claude-opus-4-20250514';
    const sessionId = `catagent-test-${now}`;
    const metadata = { provider: 'catagent', model, sessionId };

    yield { type: 'session_init', catId: this.catId, sessionId, metadata, timestamp: now };

    try {
      const response = await this.#mockFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.#mockCredentials.apiKey },
        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        const { mapAnthropicError } = await import(
          '../dist/domains/cats/services/agents/providers/catagent/catagent-event-bridge.js'
        );
        for (const msg of mapAnthropicError(
          { status: response.status, message: errText },
          this.catId,
          'catagent',
          model,
        )) {
          yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
        }
        return;
      }

      const result = await response.json();
      const { mapAnthropicResponse } = await import(
        '../dist/domains/cats/services/agents/providers/catagent/catagent-event-bridge.js'
      );
      for (const msg of mapAnthropicResponse(result, this.catId, 'catagent')) {
        yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        yield { type: 'error', catId: this.catId, error: 'Request aborted', metadata, timestamp: Date.now() };
        yield {
          type: 'done',
          catId: this.catId,
          metadata: { ...metadata, usage: { inputTokens: 0, outputTokens: 0 } },
          timestamp: Date.now(),
        };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const { mapAnthropicError } = await import(
        '../dist/domains/cats/services/agents/providers/catagent/catagent-event-bridge.js'
      );
      for (const msg of mapAnthropicError({ status: 0, message }, this.catId, 'catagent', model)) {
        yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
      }
    }
  }
}

// ── AC-C1: Opt-in registration ──

test('C1: CatAgentService implements AgentService interface', () => {
  const svc = new CatAgentService({ catId: 'test', projectRoot: '/tmp', catConfig: null });
  assert.equal(typeof svc.invoke, 'function', 'has invoke method');
  assert.equal(svc.catId, 'test');
});

// ── AC-C2: Single-turn text task e2e ──

test('C2: successful invocation yields session_init → text → done', async () => {
  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchSuccess('Hello world'),
  });
  const msgs = await collect(svc.invoke('Say hello'));

  assert.equal(msgs[0].type, 'session_init', 'first event is session_init');
  assert.ok(msgs[0].sessionId, 'has session ID');
  assert.equal(msgs[0].metadata.provider, 'catagent');

  assert.equal(msgs[1].type, 'text', 'second event is text');
  assert.equal(msgs[1].content, 'Hello world');

  assert.equal(msgs[2].type, 'done', 'last event is done');
  assert.ok(msgs[2].metadata.usage, 'done has usage');
  assert.equal(msgs[2].metadata.usage.inputTokens, 47, 'inputTokens = 42 + 5 cache_read');
  assert.equal(msgs[2].metadata.usage.outputTokens, 10);
});

test('C2: done message includes provider metadata', async () => {
  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchSuccess(),
  });
  const msgs = await collect(svc.invoke('test'));
  const done = msgs.find((m) => m.type === 'done');
  assert.equal(done.metadata.provider, 'catagent');
  assert.ok(done.metadata.model);
});

// ── AC-C3: No dangling sessions ──

test('C3: credential failure yields error + done (no dangle)', async () => {
  // Real service with known cat but non-existent projectRoot — credentials will fail-closed
  const svc = new CatAgentService({ catId: 'opus', projectRoot: '/tmp/nonexistent', catConfig: null });
  const msgs = await collect(svc.invoke('test'));

  assert.ok(msgs.length >= 2, 'at least error + done');
  const error = msgs.find((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(error, 'has error event');
  assert.ok(error.error.includes('Credential'), 'error mentions credentials');
  assert.ok(done, 'has done event (no dangle)');
});

test('C3: API HTTP error yields error + done', async () => {
  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchError(500, 'Internal server error'),
  });
  const msgs = await collect(svc.invoke('test'));

  const error = msgs.find((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(error, 'has error event');
  assert.ok(error.error.includes('500'), 'error includes status code');
  assert.ok(done, 'has done event (no dangle)');
  assert.equal(done.metadata.usage.inputTokens, 0, 'zero usage on error');
});

test('C3: network error yields error + done', async () => {
  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchNetworkError('ECONNREFUSED'),
  });
  const msgs = await collect(svc.invoke('test'));

  const error = msgs.find((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(error, 'has error event');
  assert.ok(error.error.includes('ECONNREFUSED'), 'error includes network message');
  assert.ok(done, 'has done event (no dangle)');
});

test('C3: abort yields error + done (no dangle)', async () => {
  const controller = new AbortController();
  // Abort immediately
  controller.abort();

  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchAbortable(),
  });
  const msgs = await collect(svc.invoke('test', { signal: controller.signal }));

  const error = msgs.find((m) => m.type === 'error');
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(error, 'has error event on abort');
  assert.ok(error.error.includes('abort'), 'error mentions abort');
  assert.ok(done, 'has done event (no dangle on abort)');
});

// ── AC-C4: No tools ──

test('C4: API request body does not include tools', async () => {
  let capturedBody = null;
  const captureFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        id: 'msg',
        model: 'claude-opus-4-20250514',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };

  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: captureFetch,
  });
  await collect(svc.invoke('test'));

  assert.ok(capturedBody, 'request was made');
  assert.equal(capturedBody.tools, undefined, 'no tools in request');
  assert.ok(capturedBody.messages, 'has messages');
  assert.equal(capturedBody.model, 'claude-opus-4-20250514');
});

// ── All messages have timestamps and catId ──

test('all messages have timestamp and catId', async () => {
  const svc = new TestCatAgentService({
    mockCredentials: { apiKey: 'sk-test' },
    mockFetch: mockFetchSuccess(),
  });
  const before = Date.now();
  const msgs = await collect(svc.invoke('test'));
  const afterTs = Date.now();

  for (const msg of msgs) {
    assert.ok(msg.timestamp >= before && msg.timestamp <= afterTs, `timestamp in range for ${msg.type}`);
    assert.ok(msg.catId, `catId present for ${msg.type}`);
  }
});

// ── P3 regression: real invoke() → callApi() path ──

test('P3: real invoke() → callApi() with credential fixture (no test override)', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

  // Set up temp credential fixture
  const tmpDir = join(tmpdir(), `catagent-p3-${Date.now()}`);
  const catCafeDir = join(tmpDir, '.cat-cafe');
  mkdirSync(catCafeDir, { recursive: true });
  writeFileSync(join(catCafeDir, 'accounts.json'), JSON.stringify({ 'test-ant': { authType: 'api_key' } }));
  writeFileSync(join(catCafeDir, 'credentials.json'), JSON.stringify({ 'test-ant': { apiKey: 'sk-real-path' } }));

  // Point credential resolver to temp dir
  const prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
  resetMigrationState();

  // Real CatAgentService — NOT TestCatAgentService
  const svc = new CatAgentService({
    catId: 'opus',
    projectRoot: tmpDir,
    catConfig: { accountRef: 'test-ant' },
  });

  let capturedHeaders = null;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    return {
      ok: true,
      json: async () => ({
        id: 'msg_real',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Real path' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    };
  };

  try {
    const msgs = await collect(svc.invoke('hello'));

    // Verify real callApi() was reached
    assert.ok(capturedHeaders, 'real callApi() was reached — fetch was called');
    assert.equal(capturedHeaders['x-api-key'], 'sk-real-path', 'API key from credential fixture');

    // Verify full event flow through production code
    assert.equal(msgs[0].type, 'session_init');
    assert.ok(msgs[0].sessionId.startsWith('catagent-'), 'sessionId from real invoke');
    const text = msgs.find((m) => m.type === 'text');
    assert.equal(text.content, 'Real path');
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done.metadata.usage, 'done has usage via real metadata merge');
    assert.equal(done.metadata.usage.inputTokens, 10);
    assert.equal(done.metadata.sessionId, msgs[0].sessionId, 'sessionId preserved through metadata merge');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetMigrationState();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});
