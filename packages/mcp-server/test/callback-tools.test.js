/**
 * MCP Callback Tools Tests
 * 测试 MCP 回传工具的 HTTP 调用逻辑
 *
 * Uses globalThis.fetch mocking since tools use fetch() internally.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Callback Tools', () => {
  let originalEnv;
  let originalFetch;
  let outboxDir;

  beforeEach(() => {
    // Save and set env vars
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-mcp-outbox-test-${Date.now()}-${Math.random()}`);
    mkdirSync(outboxDir, { recursive: true });
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outboxDir;

    // Save original fetch
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);

    // Restore fetch
    globalThis.fetch = originalFetch;

    // Clean outbox test dir
    if (outboxDir && existsSync(outboxDir)) {
      rmSync(outboxDir, { recursive: true, force: true });
    }
  });

  test('handlePostMessage calls API with correct body', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({ content: 'Hello from cat!' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/post-message'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.content, 'Hello from cat!');
    assert.equal(body.invocationId, 'test-invocation');
    assert.equal(body.callbackToken, 'test-token');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handlePostMessage forwards optional threadId for cross-thread posting', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({
      content: 'cross-thread ping',
      threadId: 'thread-123',
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.threadId, 'thread-123');
  });

  test('handlePostMessage returns error when env vars missing', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;

    const result = await handlePostMessage({ content: 'Hello' });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('not configured'));
  });

  test('handlePostMessage detects stale_ignored and returns error', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'stale_ignored' }),
    });

    const result = await handlePostMessage({ content: 'Hello from stale invocation' });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('stale_ignored'));
    assert.ok(result.content[0].text.includes('NOT delivered'));
  });

  test('handlePostMessage treats normal success as success (not stale)', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', messageId: 'msg-123' }),
    });

    const result = await handlePostMessage({ content: 'Hello' });

    assert.equal(result.isError, undefined);
  });

  test('handleGetPendingMentions calls API with auth in headers', async () => {
    const { handleGetPendingMentions } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ mentions: [] }),
      };
    };

    const result = await handleGetPendingMentions({});

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/pending-mentions'));
    assert.ok(capturedUrl.includes('invocationId=test-invocation'));
    assert.ok(capturedUrl.includes('callbackToken=test-token'));
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleGetThreadContext calls API with limit', async () => {
    const { handleGetThreadContext } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ messages: [] }),
      };
    };

    const result = await handleGetThreadContext({ limit: 10 });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/thread-context'));
    assert.ok(capturedUrl.includes('limit=10'));
  });

  test('handleGetThreadContext works without limit', async () => {
    const { handleGetThreadContext } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ messages: [] }),
      };
    };

    const result = await handleGetThreadContext({});

    assert.equal(result.isError, undefined);
    assert.ok(!capturedUrl.includes('limit='));
  });

  test('handleGetThreadContext forwards catId/keyword filters', async () => {
    const { handleGetThreadContext } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ messages: [] }),
      };
    };

    const result = await handleGetThreadContext({
      limit: 20,
      threadId: 'thread-42',
      catId: 'user',
      keyword: 'redis lock',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/thread-context'));
    assert.ok(capturedUrl.includes('limit=20'));
    assert.ok(capturedUrl.includes('threadId=thread-42'));
    assert.ok(capturedUrl.includes('catId=user'));
    assert.ok(capturedUrl.includes('keyword=redis+lock'));
  });

  test('handleListThreads forwards limit/activeSince filters', async () => {
    const { handleListThreads } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ threads: [] }),
      };
    };

    const result = await handleListThreads({
      limit: 15,
      activeSince: 1234567890,
      keyword: 'design review',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/list-threads'));
    assert.ok(capturedUrl.includes('limit=15'));
    assert.ok(capturedUrl.includes('activeSince=1234567890'));
    assert.ok(capturedUrl.includes('keyword=design+review'));
  });

  test('handleCrossPostMessage calls post-message with threadId', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-cross',
      content: 'hello from another thread',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/post-message'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.threadId, 'thread-cross');
    assert.equal(body.content, 'hello from another thread');
  });

  test('handleListTasks forwards threadId/catId/status filters', async () => {
    const { handleListTasks } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ tasks: [] }),
      };
    };

    const result = await handleListTasks({
      threadId: 'thread-42',
      catId: 'codex',
      status: 'blocked',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/list-tasks'));
    assert.ok(capturedUrl.includes('threadId=thread-42'));
    assert.ok(capturedUrl.includes('catId=codex'));
    assert.ok(capturedUrl.includes('status=blocked'));
  });

  test('handleFeatIndex forwards limit/featId/query filters', async () => {
    const { handleFeatIndex } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ items: [] }),
      };
    };

    const result = await handleFeatIndex({
      limit: 25,
      featId: 'F043',
      query: 'mcp',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/feat-index'));
    assert.ok(capturedUrl.includes('limit=25'));
    assert.ok(capturedUrl.includes('featId=F043'));
    assert.ok(capturedUrl.includes('query=mcp'));
  });

  test('handles API error response', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid credentials',
    });

    const result = await handlePostMessage({ content: 'Hello' });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('401'));
  });

  test('adds generic @mention fallback hint on non-credential post failure', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    });

    const result = await handlePostMessage({ content: '@gemini please check' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(text.includes('这次 post-message 调用失败'));
    assert.ok(!text.includes('token 已过期'));
    assert.ok(text.includes('直接在你的回复文本里另起一行写 @猫名'));
  });

  test('adds credential hint on callback credential failure with @mention', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Invalid or expired callback credentials' }),
    });

    const result = await handlePostMessage({ content: '@codex ping' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(text.includes('callback 凭证校验失败'));
    assert.ok(text.includes('可能是 token 过期，也可能 invocation/token 不匹配'));
  });

  test('handleSearchEvidence calls callback endpoint with encoded query params', async () => {
    const { handleCallbackSearchEvidence } = await import('../dist/tools/callback-memory-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [] }),
      };
    };

    const result = await handleCallbackSearchEvidence({
      query: 'phase 5 bank policy',
      limit: 4,
      budget: 'high',
      tags: 'project:cat-cafe,kind:decision',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/search-evidence'));
    assert.ok(capturedUrl.includes('q=phase+5+bank+policy'));
    assert.ok(capturedUrl.includes('limit=4'));
    assert.ok(capturedUrl.includes('budget=high'));
    assert.ok(capturedUrl.includes('tags=project%3Acat-cafe%2Ckind%3Adecision'));
  });

  test('handleReflectProject posts query to callback reflect endpoint', async () => {
    const { handleCallbackReflect } = await import('../dist/tools/callback-memory-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ reflection: 'Use evidence-first routing.' }),
      };
    };

    const result = await handleCallbackReflect({ query: 'How to reduce context drift?' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/reflect'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.query, 'How to reduce context drift?');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleRetainMemory posts content/tags/metadata to callback retain endpoint', async () => {
    const { handleCallbackRetainMemory } = await import('../dist/tools/callback-memory-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handleCallbackRetainMemory({
      content: 'Prefer explicit invocation lifecycle state transitions.',
      tags: ['kind:decision', 'author:codex'],
      metadata: {
        anchor: 'docs/decisions/008-conversation-mutability-and-invocation-lifecycle.md#L1',
        confidence: 'high',
      },
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/retain-memory'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.content, 'Prefer explicit invocation lifecycle state transitions.');
    assert.deepEqual(body.tags, ['kind:decision', 'author:codex']);
    assert.equal(body.metadata.anchor, 'docs/decisions/008-conversation-mutability-and-invocation-lifecycle.md#L1');
  });

  test('retries transient post failure and keeps same clientMessageId', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    let attempts = 0;
    const observedIds = [];
    globalThis.fetch = async (_url, options) => {
      attempts += 1;
      const body = JSON.parse(options.body);
      observedIds.push(body.clientMessageId);

      if (attempts === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service unavailable',
        };
      }
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({ content: 'retry me' });

    assert.equal(result.isError, undefined);
    assert.equal(attempts, 2);
    assert.ok(observedIds[0], 'clientMessageId should be present');
    assert.equal(observedIds[0], observedIds[1], 'same id must be reused across retries');
  });

  test('queues post-message to local outbox when transient failures exhaust retries', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    });

    const result = await handlePostMessage({
      content: 'offline message',
      clientMessageId: 'offline-001',
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('queued_for_retry'));

    const files = readdirSync(outboxDir);
    assert.equal(files.length, 1, 'outbox should contain one queued payload');
    const persisted = JSON.parse(readFileSync(join(outboxDir, files[0]), 'utf8'));
    assert.equal(persisted.path, '/api/callbacks/post-message');
    assert.equal(persisted.body.content, 'offline message');
    assert.equal(persisted.body.clientMessageId, 'offline-001');
  });

  test('flushes queued outbox payload before posting new message after recovery', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    // Step 1: enqueue by forcing transient failures.
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    });
    await handlePostMessage({
      content: 'queued-first',
      clientMessageId: 'queued-001',
    });
    assert.equal(readdirSync(outboxDir).length, 1, 'precondition: one queued payload exists');

    // Step 2: recover network and verify replay + current post both sent.
    const observedContents = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      observedContents.push(body.content);
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({
      content: 'current-message',
      clientMessageId: 'current-001',
    });

    assert.equal(result.isError, undefined);
    assert.ok(observedContents.includes('queued-first'));
    assert.ok(observedContents.includes('current-message'));
    assert.equal(readdirSync(outboxDir).length, 0, 'outbox should be drained after successful replay');
  });

  test('flushes at most configured outbox batch size per post', async () => {
    process.env.CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH = '2';
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    const seed = (queuedAt, id, content) => {
      const payload = {
        id,
        queuedAt,
        apiUrl: 'http://127.0.0.1:3004',
        path: '/api/callbacks/post-message',
        body: {
          invocationId: 'test-invocation',
          callbackToken: 'test-token',
          content,
          clientMessageId: id,
        },
        attempts: 0,
        lastError: 'seeded',
      };
      writeFileSync(join(outboxDir, `${queuedAt}-${id}.json`), JSON.stringify(payload), 'utf8');
    };

    seed(1, 'queued-1', 'queued-1');
    seed(2, 'queued-2', 'queued-2');
    seed(3, 'queued-3', 'queued-3');

    const posted = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      posted.push(body.content);
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({
      content: 'current-message',
      clientMessageId: 'current-001',
    });

    assert.equal(result.isError, undefined);
    assert.ok(posted.includes('queued-1'));
    assert.ok(posted.includes('queued-2'));
    assert.ok(!posted.includes('queued-3'), 'third entry should wait for next flush batch');
    assert.ok(posted.includes('current-message'));
    assert.equal(readdirSync(outboxDir).length, 1, 'one queued entry should remain after bounded flush');
  });

  test('handleRequestPermission posts action+reason to request-permission endpoint', async () => {
    const { handleRequestPermission } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'granted' }),
      };
    };

    const result = await handleRequestPermission({
      action: 'git_commit',
      reason: 'Committing bug fix',
      context: 'Fix for issue #42',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/request-permission'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.action, 'git_commit');
    assert.equal(body.reason, 'Committing bug fix');
    assert.equal(body.context, 'Fix for issue #42');
    assert.equal(body.invocationId, 'test-invocation');
    assert.equal(body.callbackToken, 'test-token');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
    assert.ok(result.content[0].text.includes('granted'));
  });

  test('handleRequestPermission omits context when not provided', async () => {
    const { handleRequestPermission } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'pending', requestId: 'req-123' }),
      };
    };

    const result = await handleRequestPermission({
      action: 'file_delete',
      reason: 'Cleaning temp files',
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.action, 'file_delete');
    assert.equal(body.context, undefined);
    assert.ok(result.content[0].text.includes('pending'));
  });

  test('handleCheckPermissionStatus queries permission-status endpoint', async () => {
    const { handleCheckPermissionStatus } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({
          requestId: 'req-123',
          status: 'granted',
          action: 'git_commit',
          createdAt: 1234567890,
        }),
      };
    };

    const result = await handleCheckPermissionStatus({ requestId: 'req-123' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/permission-status'));
    assert.ok(capturedUrl.includes('requestId=req-123'));
    assert.ok(capturedUrl.includes('invocationId=test-invocation'));
    assert.ok(capturedUrl.includes('callbackToken=test-token'));
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
    assert.ok(result.content[0].text.includes('granted'));
  });

  test('handleRequestPermission returns error when env vars missing', async () => {
    const { handleRequestPermission } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;

    const result = await handleRequestPermission({
      action: 'git_commit',
      reason: 'test',
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('not configured'));
  });

  test('drops retryable outbox entry when attempts reached max threshold', async () => {
    process.env.CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS = '2';
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    const stale = {
      id: 'stale-001',
      queuedAt: 1,
      apiUrl: 'http://127.0.0.1:3004',
      path: '/api/callbacks/post-message',
      body: {
        invocationId: 'test-invocation',
        callbackToken: 'test-token',
        content: 'stale-message',
        clientMessageId: 'stale-001',
      },
      attempts: 2,
      lastError: 'still failing',
    };
    writeFileSync(join(outboxDir, `${stale.queuedAt}-${stale.id}.json`), JSON.stringify(stale), 'utf8');

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.content === 'stale-message') {
        return {
          ok: false,
          status: 503,
          text: async () => 'still unavailable',
        };
      }
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({
      content: 'current-message',
      clientMessageId: 'current-002',
    });

    assert.equal(result.isError, undefined);
    assert.equal(readdirSync(outboxDir).length, 0, 'stale entry should be dropped after max attempts');
  });

  // ---- #476: outbox legacy fixup — pre-migration entries have creds in body, not headers ----

  test('flushes pre-#476 outbox entry with creds in body by migrating them to headers', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    // Seed a legacy outbox entry: has invocationId/callbackToken in body, NO headers field
    const legacyEntry = {
      id: 'legacy-001',
      queuedAt: 1,
      apiUrl: 'http://127.0.0.1:3004',
      path: '/api/callbacks/post-message',
      body: {
        invocationId: 'legacy-inv',
        callbackToken: 'legacy-tok',
        content: 'legacy-queued-message',
        clientMessageId: 'legacy-001',
      },
      // NOTE: no "headers" field — this is the pre-#476 format
      attempts: 0,
      lastError: 'seeded',
    };
    writeFileSync(
      join(outboxDir, `${legacyEntry.queuedAt}-${legacyEntry.id}.json`),
      JSON.stringify(legacyEntry),
      'utf8',
    );

    const replayedHeaders = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.content === 'legacy-queued-message') {
        replayedHeaders.push({ ...options.headers });
      }
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handlePostMessage({
      content: 'current-after-legacy',
      clientMessageId: 'current-legacy-001',
    });

    assert.equal(result.isError, undefined);
    assert.equal(replayedHeaders.length, 1, 'legacy entry should have been replayed');
    assert.equal(
      replayedHeaders[0]['x-invocation-id'],
      'legacy-inv',
      'replay must extract invocationId from body into x-invocation-id header',
    );
    assert.equal(
      replayedHeaders[0]['x-callback-token'],
      'legacy-tok',
      'replay must extract callbackToken from body into x-callback-token header',
    );
    assert.equal(readdirSync(outboxDir).length, 0, 'legacy entry should be drained after success');
  });

  // ---- #84: create_rich_block Route A → Route B fallback ----

  test('handleCreateRichBlock succeeds via Route A when callback works', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url, _options) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const block = JSON.stringify({ id: 'c1', kind: 'card', v: 1, title: 'Test' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/create-rich-block'));
  });

  test('handleCreateRichBlock falls back to Route B (post_message + cc_rich) when Route A fails', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const capturedUrls = [];
    globalThis.fetch = async (url, _options) => {
      capturedUrls.push(url);
      if (url.includes('create-rich-block')) {
        // Route A fails
        return { ok: false, status: 401, text: async () => 'Expired' };
      }
      // Route B (post-message) succeeds
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const block = JSON.stringify({ id: 'd1', kind: 'diff', v: 1, filePath: 'x.ts', diff: '-a\n+b' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('B_fallback'), 'should indicate Route B fallback was used');
    // Verify both endpoints were tried
    assert.ok(
      capturedUrls.some((u) => u.includes('create-rich-block')),
      'Route A attempted',
    );
    assert.ok(
      capturedUrls.some((u) => u.includes('post-message')),
      'Route B fallback attempted',
    );
  });

  test('handleCreateRichBlock returns error with cc_rich hint when both routes fail', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Expired token',
    });

    const block = JSON.stringify({ id: 'c2', kind: 'card', v: 1, title: 'Hint Test' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(text.includes('cc_rich'), 'error should contain cc_rich hint text');
    assert.ok(text.includes('Hint Test'), 'error should contain the block content');
  });

  test('handleCreateRichBlock does NOT fallback on validation error (400)', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const capturedUrls = [];
    globalThis.fetch = async (url, _options) => {
      capturedUrls.push(url);
      // Route A returns 400 validation error
      return { ok: false, status: 400, text: async () => 'Missing required card fields' };
    };

    const block = JSON.stringify({ id: 'v1', kind: 'card', v: 1, title: 'Test' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('400'), 'should surface the 400 error');
    // Should NOT have attempted post-message (Route B)
    assert.ok(
      !capturedUrls.some((u) => u.includes('post-message')),
      'should NOT fallback to Route B for validation errors',
    );
  });

  test('handleCreateRichBlock rejects invalid JSON', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const result = await handleCreateRichBlock({ block: 'not json {' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('Invalid JSON'));
  });

  test('handleCreateRichBlock rejects block without id or kind', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const result = await handleCreateRichBlock({ block: '{"v": 1}' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('id and kind'));
  });

  test('#85 M2c: handleCreateRichBlock normalizes type→kind before validation', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    let capturedBody;
    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    // Uses "type" instead of "kind", no "v" — should be normalized
    const block = JSON.stringify({ id: 'b1', type: 'card', title: 'Test' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, undefined);
    // Verify the block sent to Route A was normalized
    assert.equal(capturedBody.block.kind, 'card');
    assert.equal(capturedBody.block.type, undefined);
    assert.equal(capturedBody.block.v, 1);
  });

  // ---- F086: multi_mention ----

  test('handleMultiMention calls /api/callbacks/multi-mention with correct payload', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ requestId: 'req-123', status: 'pending' }),
      };
    };

    const result = await handleMultiMention({
      targets: ['codex', 'gemini'],
      question: 'What do you think about this API design?',
      callbackTo: 'opus',
      timeoutMinutes: 8,
      searchEvidenceRefs: ['docs/features/F055.md'],
      triggerType: 'cross-domain',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/multi-mention'));
    const body = JSON.parse(capturedOptions.body);
    assert.deepEqual(body.targets, ['codex', 'gemini']);
    assert.equal(body.question, 'What do you think about this API design?');
    assert.equal(body.callbackTo, 'opus');
    assert.equal(body.timeoutMinutes, 8);
    assert.deepEqual(body.searchEvidenceRefs, ['docs/features/F055.md']);
    assert.equal(body.triggerType, 'cross-domain');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleMultiMention rejects missing searchEvidenceRefs and overrideReason', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');

    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'test',
      callbackTo: 'opus',
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('searchEvidenceRefs'));
    assert.ok(result.content[0].text.includes('先搜后问'));
  });

  test('handleMultiMention accepts overrideReason instead of searchEvidenceRefs', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ requestId: 'req-456', status: 'pending' }),
      };
    };

    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'Urgent: production issue',
      callbackTo: 'opus',
      overrideReason: 'Production emergency, no time to search',
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.overrideReason, 'Production emergency, no time to search');
    assert.equal(body.searchEvidenceRefs, undefined);
  });

  test('handleMultiMention omits optional fields when undefined', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ requestId: 'req-789', status: 'pending' }),
      };
    };

    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'test',
      callbackTo: 'opus',
      searchEvidenceRefs: ['docs/test.md'],
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.context, undefined);
    assert.equal(body.idempotencyKey, undefined);
    assert.equal(body.timeoutMinutes, undefined);
    assert.equal(body.overrideReason, undefined);
    assert.equal(body.triggerType, undefined);
  });

  // ---- handleRegisterPrTracking payload semantics ----

  test('handleRegisterPrTracking omits catId from body when not provided', async () => {
    const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleRegisterPrTracking({ repoFullName: 'zts212653/cat-cafe', prNumber: 832 });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.repoFullName, 'zts212653/cat-cafe');
    assert.equal(body.prNumber, 832);
    assert.equal(body.catId, undefined, 'catId must not appear in body when omitted');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleRegisterPrTracking forwards catId when provided (backward compat)', async () => {
    const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleRegisterPrTracking({ repoFullName: 'zts212653/cat-cafe', prNumber: 100, catId: 'opus' });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.catId, 'opus', 'catId must be forwarded when caller provides it');
    assert.equal(body.repoFullName, 'zts212653/cat-cafe');
    assert.equal(body.prNumber, 100);
  });
});
