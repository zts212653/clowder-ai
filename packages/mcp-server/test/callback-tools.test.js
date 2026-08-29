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
    // shared-rules §19 (LL-054): closed loopback port — defense-in-depth.
    // If a test forgets to override fetch, ECONNREFUSED keeps requests off
    // the runtime callback endpoint.
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-mcp-outbox-test-${Date.now()}-${Math.random()}`);
    mkdirSync(outboxDir, { recursive: true });
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outboxDir;

    // Save original fetch
    originalFetch = globalThis.fetch;
    // shared-rules §19 default fetch stub — every test inherits a no-op,
    // preventing accidental real HTTP if a test forgets to override.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
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
    // F174 Phase F (AC-F2): first-party MCP client stopped dual-writing creds.
    // Headers are now the only place creds appear.
    assert.equal(body.invocationId, undefined, 'creds must NOT be dual-written to body');
    assert.equal(body.callbackToken, undefined, 'creds must NOT be dual-written to body');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handlePostMessage forwards the exact F247 source binding fields', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handlePostMessage({
      content: 'source-bound cloud return',
      replyTo: 'source-message-7',
      cloudReturnBinding: 'cbr1.aW52LWNsb3Vk.signature',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.replyTo, 'source-message-7');
    assert.equal(body.cloudReturnBinding, 'cbr1.aW52LWNsb3Vk.signature');
  });

  test('handlePostMessage rejects an invalid action subjectRef before sending or queueing a callback', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'Review the first PR head.',
      targetCats: ['codex'],
      clientMessageId: 'invalid-subject-ref',
      action: {
        subjectRef: 'github:zts212653/cat-cafe#3677@181099d2',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /pr:<owner>\/<repo>#<positive-number>/);
    assert.match(result.content[0].text, /subject:<namespace>:<opaque-id>/);
    assert.equal(attempts, 0, 'invalid metadata must not reach the callback transport');
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
    );
  });

  test('post_message exposes only action pairs with an executable terminal producer', async () => {
    const { handlePostMessage, postMessageInputSchema } = await import('../dist/tools/callback-tools.js');
    const impossibleMerge = {
      subjectRef: 'pr:owner/repo#3684',
      actionFamily: 'merge',
      successorSlot: 'merge_owner',
      mode: 'single',
      terminalPredicate: { kind: 'pr_merged' },
    };

    const advertised = postMessageInputSchema.action.safeParse(impossibleMerge);
    assert.equal(advertised.success, false, 'the public tool schema must not advertise an unregistered producer');

    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const result = await handlePostMessage({
      content: 'Merge after the verified gate.',
      targetCats: ['codex-sol'],
      clientMessageId: 'impossible-merge-carrier',
      action: impossibleMerge,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /review.*review_delivered/i);
    assert.match(result.content[0].text, /implement.*task_done/i);
    assert.equal(attempts, 0, 'unsupported action metadata must not reach callback transport');
  });

  test('handlePostMessage forwards replace_final disposition to the callback API', async () => {
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
      content: 'Canonical callback response',
      streamDisposition: 'replace_final',
    });

    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(capturedOptions.body).streamDisposition, 'replace_final');
  });

  test('handleCompleteManagedHold exposes only the invocation-bound disposition input', async () => {
    const { handleCompleteManagedHold } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ outcome: 'applied' }) };
    };

    const result = await handleCompleteManagedHold({ disposition: 'completed' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.endsWith('/api/callbacks/complete-managed-hold'));
    assert.deepEqual(JSON.parse(capturedOptions.body), { disposition: 'completed' });
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleCompleteA2ADispatch exposes only the invocation-bound disposition input', async () => {
    const { handleCompleteA2ADispatch } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ outcome: 'applied' }) };
    };

    const result = await handleCompleteA2ADispatch({ disposition: 'handled' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.endsWith('/api/callbacks/complete-a2a-dispatch'));
    assert.deepEqual(JSON.parse(capturedOptions.body), { disposition: 'handled' });
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleUpdateWorkflow forwards taskId for deterministic task-backed Mission Hub import', async () => {
    const { handleUpdateWorkflow } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleUpdateWorkflow({ featureId: 'F287', taskId: 'task-f287', stage: 'impl' });

    assert.ok(capturedUrl.endsWith('/api/callbacks/update-workflow-sop'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.featureId, 'F287');
    assert.equal(body.taskId, 'task-f287');
    assert.equal(body.stage, 'impl');
  });

  test('handlePostMessage forwards same-thread coordination lifecycle metadata', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'APPROVE exact HEAD; no open items.',
      targetCats: ['opus'],
      clientMessageId: 'local-review-terminal',
      coordination: {
        phase: 'terminal',
        id: 'coord-local-review',
        subjectRef: 'pr:owner/repo#3515',
      },
      localReviewVerdict: 'approved',
      reviewedHeadSha: 'a'.repeat(40),
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).coordination, {
      phase: 'terminal',
      id: 'coord-local-review',
      subjectRef: 'pr:owner/repo#3515',
    });
    assert.equal(JSON.parse(capturedOptions.body).localReviewVerdict, 'approved');
    assert.equal(JSON.parse(capturedOptions.body).reviewedHeadSha, 'a'.repeat(40));
  });

  test('handlePostMessage rejects a typed local verdict without invocation credentials', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'agent-key-only';
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'Human-readable review result.',
      threadId: 'thread-review',
      clientMessageId: 'typed-local-review-agent-key',
      coordination: { phase: 'terminal' },
      localReviewVerdict: 'approved',
      reviewedHeadSha: 'b'.repeat(40),
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /localReviewVerdict.*invocation-token/i);
    assert.equal(attempts, 0);
  });

  test('handlePostMessage rejects reviewedHeadSha without a typed local verdict before transport', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'HEAD alone is not a review fact.',
      reviewedHeadSha: 'c'.repeat(40),
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /reviewedHeadSha requires localReviewVerdict/);
    assert.equal(attempts, 0);
  });

  test('handleGetMessage forwards mode + stays pass-through (F236 AC-A5/B1)', async () => {
    const { handleGetMessage } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    // route returns an already-anchored payload; the MCP handler must NOT re-transform it
    const routePayload = { message: { id: 'm1', preview: 'excerpt', truncated: true, contentLength: 500 } };
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => routePayload };
    };

    const result = await handleGetMessage({ messageId: 'm1', mode: 'full' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/get-message'));
    assert.ok(capturedUrl.includes('messageId=m1'));
    assert.ok(capturedUrl.includes('mode=full'), 'mode forwarded to route (truncation lives in route layer, AC-A5)');
    // pass-through: route payload returned verbatim, anchor fields intact
    assert.deepEqual(JSON.parse(result.content[0].text), routePayload);
  });

  test('handleListTasks forwards taskId why-drill param (F236 AC-A4)', async () => {
    const { handleListTasks } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ tasks: [] }) };
    };

    await handleListTasks({ taskId: 'task-123' });

    assert.ok(capturedUrl.includes('/api/callbacks/list-tasks'));
    assert.ok(capturedUrl.includes('taskId=task-123'), 'taskId forwarded for full-why drill');
  });

  test('handlePostMessage forwards threadId for agent-key callers (F178)', async () => {
    // F193 KD-1: principal detection follows buildAuthHeaders precedence —
    // if env has BOTH invocation_id AND callback_token, request is
    // invocation-token regardless of input.agentKeyCatId. To exercise the
    // agent-key path, MUST unset invocation env vars (closing 砚砚 review P1).
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    const agentKeyFile = join(outboxDir, 'antigravity-agent-key.secret');
    writeFileSync(agentKeyFile, 'test-agent-key\n', { mode: 0o600 });
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ antigravity: agentKeyFile });
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
      agentKeyCatId: 'antigravity', // F178 agent-key path
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.threadId, 'thread-123');
  });

  test('handlePostMessage rejects replace_final without an invocation stream', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'There is no provider final to replace',
      threadId: 'thread-123',
      streamDisposition: 'replace_final',
      agentKeyCatId: 'antigravity',
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires invocation-token credentials/);
    assert.equal(attempts, 0);
  });

  test('agent-key action rejection is not retried or queued to the outbox', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    const agentKeyFile = join(outboxDir, 'antigravity-action-agent-key.secret');
    writeFileSync(agentKeyFile, 'test-agent-key\n', { mode: 0o600 });
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ antigravity: agentKeyFile });

    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            status: 'action_agent_key_unsupported',
            message: 'Structured action successors require invocation-token provenance.',
          }),
      };
    };

    const result = await handlePostMessage({
      content: 'Review PR 2915',
      threadId: 'thread-123',
      targetCats: ['codex'],
      clientMessageId: 'agent-review-2915',
      agentKeyCatId: 'antigravity',
      action: {
        subjectRef: 'pr:owner/repo#2915',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /action_agent_key_unsupported/);
    assert.equal(attempts, 1, 'permanent auth-mode rejection must not retry');
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
      'permanent auth-mode rejection must not enter outbox',
    );
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

  test('handleWithdrawThreadProposal forwards the exact proposalId with invocation auth', async () => {
    const { handleWithdrawThreadProposal } = await import('../dist/tools/callback-tools.js');
    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'proposal_1', status: 'withdrawn' }) };
    };

    const result = await handleWithdrawThreadProposal({ proposalId: 'proposal_1' });

    assert.equal(result.isError, undefined);
    assert.match(capturedUrl, /\/api\/callbacks\/withdraw-thread-proposal$/);
    assert.deepEqual(JSON.parse(capturedOptions.body), { proposalId: 'proposal_1' });
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleWithdrawThreadProposal surfaces stale_ignored as a non-withdrawal error', async () => {
    const { handleWithdrawThreadProposal } = await import('../dist/tools/callback-tools.js');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'stale_ignored' }) });

    const result = await handleWithdrawThreadProposal({ proposalId: 'proposal_1' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /NOT withdrawn/);
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
    // F174 Phase F (AC-F2): creds no longer dual-written to query.
    assert.ok(!capturedUrl.includes('invocationId='), 'creds must NOT be dual-written to query');
    assert.ok(!capturedUrl.includes('callbackToken='), 'creds must NOT be dual-written to query');
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

  test('handleGetThreadContext forwards message window parameters', async () => {
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
      threadId: 'thread-42',
      messageId: 'msg-42',
      before: 2,
      after: 4,
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/thread-context'));
    assert.ok(capturedUrl.includes('threadId=thread-42'));
    assert.ok(capturedUrl.includes('messageId=msg-42'));
    assert.ok(capturedUrl.includes('before=2'));
    assert.ok(capturedUrl.includes('after=4'));
  });

  test('handleGetThreadContext forwards an opaque continuation cursor', async () => {
    const { handleGetThreadContext } = await import('../dist/tools/callback-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ messages: [], hasMore: false }),
      };
    };

    const result = await handleGetThreadContext({
      limit: 100,
      keyword: 'budget needle',
      responseMode: 'full',
      cursor: 'opaque-page-token',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('cursor=opaque-page-token'));
    assert.ok(capturedUrl.includes('keyword=budget+needle'));
    assert.ok(capturedUrl.includes('responseMode=full'));
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
      // F193 AC-A4: cross_post requires routing creds at MCP layer
      targetCats: ['codex'],
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/post-message'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.threadId, 'thread-cross');
    assert.equal(body.content, 'hello from another thread');
  });

  test('handleCrossPostMessage forwards the exact F247 source binding fields', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleCrossPostMessage({
      threadId: 'thread-source-bound',
      content: '@codex-sol source-bound cloud return',
      targetCats: ['codex-sol'],
      replyTo: 'source-message-8',
      cloudReturnBinding: 'cbr1.aW52LWNsb3Vk.signature',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.threadId, 'thread-source-bound');
    assert.equal(body.replyTo, 'source-message-8');
    assert.equal(body.cloudReturnBinding, 'cbr1.aW52LWNsb3Vk.signature');
  });

  test('handleCrossPostMessage forwards a typed local verdict with its terminal delivery', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-author',
      content: '@codex-sol\n\n这版可以合。',
      targetCats: ['codex-sol'],
      clientMessageId: 'typed-cross-thread-local-review',
      coordination: { phase: 'terminal' },
      localReviewVerdict: 'approved',
      reviewedHeadSha: 'b'.repeat(40),
    });

    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(capturedOptions.body).localReviewVerdict, 'approved');
    assert.equal(JSON.parse(capturedOptions.body).reviewedHeadSha, 'b'.repeat(40));
  });

  test('handleCrossPostMessage forwards action identity with the caller idempotency key', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    };
    const result = await handleCrossPostMessage({
      threadId: 'thread-cross',
      content: 'Review PR 2868',
      targetCats: ['codex'],
      clientMessageId: 'review-pr-2868',
      action,
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.clientMessageId, 'review-pr-2868');
    assert.deepEqual(body.action, action);
  });

  test('handleCrossPostMessage forwards a grounded return-to-predecessor transition', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      returnToPredecessor: {
        leaseId: 'lease-review-1',
        expectedGeneration: 1,
        groundingEvidenceRef: 'grounding:mismatch',
      },
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-predecessor',
      content: 'Grounding mismatch; custody returns to the persisted predecessor.',
      targetCats: ['codex-sol'],
      clientMessageId: 'return-review-2868',
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).action, action);
  });

  test('handleCrossPostMessage accepts one-target parallel rejected-ownership disposition', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'parallel_return_unsupported' }) };
    };
    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'parallel',
      parallelIntent: 'independent review',
      returnToPredecessor: {
        leaseId: 'lease-review-1',
        expectedGeneration: 1,
        groundingEvidenceRef: 'grounding:mismatch',
      },
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-predecessor',
      content: 'I reject my holder slot; the parallel lease remains with peers.',
      targetCats: ['codex-sol'],
      clientMessageId: 'reject-review-2868',
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).action, action);
  });

  test('handleCrossPostMessage action requires explicit replay and cardinality identity', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    };

    const missingId = await handleCrossPostMessage({
      threadId: 'thread-cross',
      content: 'Review PR 2868',
      targetCats: ['codex'],
      action,
    });
    assert.equal(missingId.isError, true);
    assert.match(missingId.content[0].text, /explicit clientMessageId/);

    const wrongCardinality = await handleCrossPostMessage({
      threadId: 'thread-cross',
      content: 'Review PR 2868',
      targetCats: ['codex', 'gpt52'],
      clientMessageId: 'review-pr-2868',
      action,
    });
    assert.equal(wrongCardinality.isError, true);
    assert.match(wrongCardinality.content[0].text, /exactly one target/);
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

  test('handleFeatIndex renders suggested cross-post action', async () => {
    const { handleFeatIndex } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            featId: 'F193',
            name: 'Cross Thread Comm',
            status: 'in-progress',
            owner: '布偶猫',
            ownerCatId: 'opus',
            threadIds: ['thread-f193'],
            suggestedAction: {
              type: 'cross_post',
              threadId: 'thread-f193',
              featureId: 'F193',
              ownerCatId: 'opus',
              targetCats: ['opus'],
              reason: 'F193 is owned by opus; dispatch findings to the owning thread.',
              source: 'feat_index',
            },
          },
        ],
      }),
    });

    const result = await handleFeatIndex({ featId: 'F193' });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('F193 — Cross Thread Comm'));
    assert.ok(text.includes('owner: 布偶猫 (opus)'));
    assert.ok(text.includes('cat_cafe_cross_post_message(threadId="thread-f193", targetCats=["opus"]'));
    assert.ok(text.includes('reason: F193 is owned by opus'));
  });

  test('handleFeatIndex preserves keyDecisions in formatted output', async () => {
    const { handleFeatIndex } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            featId: 'F043',
            name: 'MCP Unification',
            status: 'spec',
            keyDecisions: ['Keep raw feature decisions visible', 'Do not hide routing contract changes'],
          },
        ],
      }),
    });

    const result = await handleFeatIndex({ featId: 'F043' });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('F043 — MCP Unification'));
    assert.ok(text.includes('key decisions:'));
    assert.ok(text.includes('- Keep raw feature decisions visible'));
    assert.ok(text.includes('- Do not hide routing contract changes'));
  });

  test('handleFeatIndex renders owner-only suggested cross-post action guidance', async () => {
    const { handleFeatIndex } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            featId: 'F194',
            name: 'Owner Only Feature',
            status: 'spec',
            owner: '布偶猫',
            ownerCatId: 'opus',
            threadIds: [],
            suggestedAction: {
              type: 'cross_post',
              featureId: 'F194',
              ownerCatId: 'opus',
              targetCats: ['opus'],
              reason: 'F194 is owned by opus; find the feature thread before dispatching findings.',
              source: 'feat_index',
            },
          },
        ],
      }),
    });

    const result = await handleFeatIndex({ featId: 'F194' });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('F194 — Owner Only Feature'));
    assert.ok(text.includes('owner: 布偶猫 (opus)'));
    assert.ok(text.includes('cat_cafe_cross_post_message(threadId="<feature-thread-id>", targetCats=["opus"]'), text);
    assert.ok(text.includes('routing: find the feature thread before sending'));
    assert.ok(text.includes('reason: F194 is owned by opus'));
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

  test('adds reason-typed credential hint on interrupted callback failure with @mention', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    // F174 Phase A: structured 401 carries reason; client routes hint by typed reason.
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: 'callback_auth_failed',
          reason: 'interrupted',
          message: 'Callback invocation was interrupted',
          hint: '...',
        }),
    });

    const result = await handlePostMessage({ content: '@codex ping' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(text.includes('exact TurnExecution 已终结（interrupted）'));
    assert.ok(text.includes('直接在你的回复文本里另起一行写 @猫名'));
  });

  test('adds invalid_token-specific hint on token mismatch with @mention', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: 'callback_auth_failed',
          reason: 'invalid_token',
          message: 'Callback token does not match invocation',
          hint: '...',
        }),
    });

    const result = await handlePostMessage({ content: '@gpt52 ping' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(text.includes('callback token 与 invocation 不匹配'));
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

  test('handleCreateRichBlock lets synthesized audio outlive the generic callback timeout', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '5';
    let attempts = 0;
    globalThis.fetch = (_url, options) =>
      new Promise((resolve, reject) => {
        attempts += 1;
        const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ status: 'ok' }) }), 40);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          },
          { once: true },
        );
      });

    const block = JSON.stringify({
      id: 'audio-slow-success',
      kind: 'audio',
      v: 1,
      text: '这条语音故意比通用 callback 超时更慢。',
    });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'ok' });
    assert.equal(attempts, 1, 'slow synthesis must stay on one callback request');
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
      'an in-progress synthesis must not be mistaken for an outbox delivery failure',
    );
  });

  test('handleCreateRichBlock does not retry or outbox a failed synthesized-audio callback', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new TypeError('synthetic transport failure');
    };

    const block = JSON.stringify({
      id: 'audio-single-attempt-failure',
      kind: 'audio',
      v: 1,
      text: '失败也只能提交一次。',
    });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    assert.equal(attempts, 1, 'audio synthesis is non-idempotent and must not be replayed');
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
      'failed synthesized audio must not enter the generic callback outbox',
    );
  });

  test('handleCreateRichBlock treats credential-file callers as invocation-auth', async () => {
    const credentialFile = join(outboxDir, 'pooled-rich-block.json');
    writeFileSync(
      credentialFile,
      JSON.stringify({ invocationId: 'pooled-rich-invocation', callbackToken: 'pooled-rich-token' }),
    );
    process.env.CAT_CAFE_CREDENTIAL_FILE = credentialFile;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ gemini25: join(outboxDir, 'agent.secret') });

    let capturedUrl;
    let capturedHeaders;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');
    const block = JSON.stringify({ id: 'pooled-rb', kind: 'card', v: 1, title: 'Pooled' });
    const result = await handleCreateRichBlock({ block, agentKeyCatId: 'gemini25' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/create-rich-block'));
    assert.equal(capturedHeaders['x-invocation-id'], 'pooled-rich-invocation');
    assert.equal(capturedHeaders['x-callback-token'], 'pooled-rich-token');
  });

  test('handleCreateRichBlock requires threadId for shared Antigravity agent-key auth', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ gemini25: join(outboxDir, 'missing.secret') });

    globalThis.fetch = async () => {
      throw new Error('fetch must not be called without threadId');
    };

    const block = JSON.stringify({ id: 'agent-rb-missing-thread', kind: 'card', v: 1, title: 'Missing Thread' });
    const result = await handleCreateRichBlock({ block, agentKeyCatId: 'gemini25' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /threadId is required/);
  });

  test('handleCreateRichBlock routes shared Antigravity agent-key calls through post_message Route B', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    const keyPath = join(outboxDir, 'gemini25.secret');
    writeFileSync(keyPath, 'gemini25-agent-key');
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ gemini25: keyPath });

    let capturedUrl;
    let capturedHeaders;
    let capturedBody;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const block = JSON.stringify({ id: 'agent-rb-1', kind: 'card', v: 1, title: 'Agent Rich Block' });
    const result = await handleCreateRichBlock({ block, threadId: 'thread-agent-rich', agentKeyCatId: 'gemini25' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/post-message'));
    assert.ok(!capturedUrl.includes('/api/callbacks/create-rich-block'));
    assert.equal(capturedHeaders['x-agent-key-secret'], 'gemini25-agent-key');
    assert.equal(capturedBody.threadId, 'thread-agent-rich');
    assert.match(capturedBody.content, /```cc_rich/);
  });

  test('handleCreateRichBlock Route B lets synthesized audio outlive the generic callback timeout', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    const keyPath = join(outboxDir, 'gemini25-audio.secret');
    writeFileSync(keyPath, 'gemini25-agent-key');
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ gemini25: keyPath });
    process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '5';

    let attempts = 0;
    globalThis.fetch = (_url, options) =>
      new Promise((resolve, reject) => {
        attempts += 1;
        const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ status: 'ok' }) }), 40);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          },
          { once: true },
        );
      });

    const block = JSON.stringify({
      id: 'agent-audio-slow-success',
      kind: 'audio',
      v: 1,
      text: 'Route B 也必须等待现场语音合成完成。',
    });
    const result = await handleCreateRichBlock({
      block,
      threadId: 'thread-agent-rich',
      agentKeyCatId: 'gemini25',
    });

    assert.equal(result.isError, undefined);
    assert.equal(attempts, 1, 'agent-key audio synthesis must stay on one callback request');
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
      'Route B synthesized audio must not enter the generic callback outbox',
    );
  });

  test('handleCreateRichBlock rejects malformed agent-key rich blocks before Route B', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ gemini25: join(outboxDir, 'missing.secret') });

    globalThis.fetch = async () => {
      throw new Error('fetch must not be called for invalid rich block payloads');
    };

    const malformedBlocks = [
      { id: 'agent-rb-invalid-card', kind: 'card', v: 1 },
      { id: 'agent-rb-invalid-checklist', kind: 'checklist', v: 1, items: [] },
    ];

    for (const malformed of malformedBlocks) {
      const result = await handleCreateRichBlock({
        block: JSON.stringify(malformed),
        threadId: 'thread-agent-rich',
        agentKeyCatId: 'gemini25',
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid rich block/);
    }
  });

  test('handleCreateRichBlock falls back to Route B (post_message + cc_rich) when Route A fails', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const capturedUrls = [];
    globalThis.fetch = async (url, _options) => {
      capturedUrls.push(url);
      if (url.includes('create-rich-block')) {
        // Route A loses registry state — unknown_invocation is the only degradable auth reason.
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({
              error: 'callback_auth_failed',
              reason: 'unknown_invocation',
              message: 'Callback invocation is unknown',
              hint: '...',
            }),
        };
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

    // F174 Phase A: 401 must include structured reason for degradation to trigger.
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: 'callback_auth_failed',
          reason: 'unknown_invocation',
          message: 'Callback invocation is unknown',
          hint: '...',
        }),
    });

    const block = JSON.stringify({ id: 'c2', kind: 'card', v: 1, title: 'Hint Test' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(text.includes('cc_rich'), 'error should contain cc_rich hint text');
    assert.ok(text.includes('Hint Test'), 'error should contain the block content');
  });

  // F174 Phase A — Reason-typed degradation contract (KD-7)
  test('handleCreateRichBlock does NOT degrade on reason:invalid_token (client bug, not transient)', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const capturedUrls = [];
    globalThis.fetch = async (url) => {
      capturedUrls.push(url);
      return {
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            error: 'callback_auth_failed',
            reason: 'invalid_token',
            message: 'Callback token does not match invocation',
            hint: '...',
          }),
      };
    };

    const block = JSON.stringify({ id: 'c3', kind: 'card', v: 1, title: 'No Degrade' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    // Route A attempted; Route B (post-message) should NOT have been attempted
    assert.ok(
      !capturedUrls.some((u) => u.includes('post-message')),
      'invalid_token must not trigger Route B fallback (it is a client bug, not transient auth failure)',
    );
  });

  test('handleCreateRichBlock does NOT degrade on un-tagged 401 (legacy API or non-JSON body)', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');

    const capturedUrls = [];
    globalThis.fetch = async (url) => {
      capturedUrls.push(url);
      return { ok: false, status: 401, text: async () => 'plain text 401' };
    };

    const block = JSON.stringify({ id: 'c4', kind: 'card', v: 1, title: 'No Degrade Legacy' });
    const result = await handleCreateRichBlock({ block });

    assert.equal(result.isError, true);
    assert.ok(
      !capturedUrls.some((u) => u.includes('post-message')),
      'un-tagged 401 must surface to caller — degradation requires explicit reason from server',
    );
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

  test('handleMultiMention rejects a non-canonical action subject before callback transport', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ requestId: 'should-not-send' }) };
    };

    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'Review the first PR head.',
      callbackTo: 'opus',
      idempotencyKey: 'invalid-multi-subject-ref',
      searchEvidenceRefs: ['message:incident-f167'],
      action: {
        subjectRef: 'github:zts212653/cat-cafe#3677@181099d2',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /pr:<owner>\/<repo>#<positive-number>/);
    assert.match(result.content[0].text, /subject:<namespace>:<opaque-id>/);
    assert.equal(attempts, 0);
    assert.deepEqual(
      readdirSync(outboxDir).filter((name) => name.endsWith('.json')),
      [],
    );
  });

  test('handleMultiMention forwards structured successor identity and replace intent', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ requestId: 'req-action', status: 'running' }) };
    };

    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      replace: { leaseId: 'lease-old', expectedGeneration: 1 },
      terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    };
    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'Take over after verified cancellation',
      callbackTo: 'opus',
      idempotencyKey: 'action-req-2',
      searchEvidenceRefs: ['pr:owner/repo#2868'],
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).action, action);
  });

  test('handleMultiMention forwards an existing-standing claim with grounding evidence', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ requestId: 'req-standing', status: 'running' }) };
    };
    const action = {
      subjectRef: 'subject:task:task-2868',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'grounding:verified-owner',
      terminalPredicate: { kind: 'task_done' },
    };
    const result = await handleMultiMention({
      targets: ['opus'],
      question: 'Claim the open reviewer slot from verified standing',
      callbackTo: 'opus',
      idempotencyKey: 'standing-req-1',
      searchEvidenceRefs: ['grounding:verified-owner'],
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).action, action);
  });

  test('handleMultiMention accepts one-target parallel rejected-ownership disposition', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'parallel_return_unsupported' }) };
    };
    const action = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'parallel',
      parallelIntent: 'independent review',
      returnToPredecessor: {
        leaseId: 'lease-review-1',
        expectedGeneration: 1,
        groundingEvidenceRef: 'grounding:mismatch',
      },
    };
    const result = await handleMultiMention({
      targets: ['codex-sol'],
      question: 'Record my holder rejection without returning the peer lease.',
      callbackTo: 'codex-terra',
      idempotencyKey: 'reject-review-2868',
      searchEvidenceRefs: ['grounding:mismatch'],
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(capturedOptions.body).action, action);
  });

  test('handleMultiMention rejects action metadata without replay identity', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    const result = await handleMultiMention({
      targets: ['codex'],
      question: 'No idempotency key',
      callbackTo: 'opus',
      searchEvidenceRefs: ['pr:owner/repo#2868'],
      action: {
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /idempotencyKey/);
  });

  test('handleMultiMention requires explicit parallel intent for multi-holder action', async () => {
    const { handleMultiMention } = await import('../dist/tools/callback-tools.js');
    const result = await handleMultiMention({
      targets: ['codex', 'opus'],
      question: 'Parallel without declared intent',
      callbackTo: 'gemini',
      idempotencyKey: 'action-parallel-1',
      searchEvidenceRefs: ['docs/design.md'],
      action: {
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /parallelIntent/);
  });

  // ---- handleRegisterPrTracking payload semantics ----

  test('handleRegisterPrTracking omits catId from body when not provided', async () => {
    const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleRegisterPrTracking({
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 832,
      when: [{ kind: 'pr_head_changed' }],
      nextStep: 'Inspect the new HEAD.',
      expiresAt: Date.now() + 60_000,
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.repoFullName, 'zts212653/cat-cafe');
    assert.equal(body.prNumber, 832);
    assert.equal(body.catId, undefined, 'catId must not appear in body when omitted');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('handleRegisterPrTracking never trusts caller-supplied catId in the body', async () => {
    const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    await handleRegisterPrTracking({
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 100,
      when: [{ kind: 'pr_ci_terminal' }],
      nextStep: 'Continue merge-gate.',
      expiresAt: Date.now() + 60_000,
      catId: 'opus',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.catId, undefined, 'cat identity must come from callback authentication');
    assert.equal(body.repoFullName, 'zts212653/cat-cafe');
    assert.equal(body.prNumber, 100);
  });

  // ── F182 KD-6: formatCatRoutingErrorPrefix unit tests ──────────────────────

  test('KD-6: formatCatRoutingErrorPrefix cat_disabled — fixed prefix + alternatives', async () => {
    const { formatCatRoutingErrorPrefix } = await import('../dist/tools/callback-tools.js');

    const result = formatCatRoutingErrorPrefix({
      kind: 'cat_disabled',
      catId: 'antigravity',
      alternatives: [
        { mention: '@opus', displayName: '布偶猫' },
        { mention: '@antig-opus', displayName: '反重力布偶猫' },
      ],
    });

    assert.ok(result.startsWith('Cat routing failed [kind=cat_disabled]'), `unexpected prefix: ${result}`);
    assert.ok(result.includes('target=@antigravity'), `missing target: ${result}`);
    assert.ok(result.includes('disabled.'), `missing disabled marker: ${result}`);
    assert.ok(result.includes('Alternatives:'), `missing alternatives: ${result}`);
    assert.ok(result.includes('@opus'), `missing @opus in alternatives: ${result}`);
  });

  test('KD-6: formatCatRoutingErrorPrefix cat_not_found — not found marker', async () => {
    const { formatCatRoutingErrorPrefix } = await import('../dist/tools/callback-tools.js');

    const result = formatCatRoutingErrorPrefix({
      kind: 'cat_not_found',
      mention: '@xyzunknown',
      alternatives: [],
    });

    assert.ok(result.includes('[kind=cat_not_found]'), `missing kind: ${result}`);
    assert.ok(result.includes('target=@xyzunknown'), `missing target: ${result}`);
    assert.ok(result.includes('not found.'), `missing not found marker: ${result}`);
  });

  test('KD-6: callbackPost wraps 400 CatRoutingError with human prefix + JSON dual-track', async () => {
    const { callbackPost } = await import('../dist/tools/callback-tools.js');

    const routingError = {
      kind: 'cat_disabled',
      catId: 'antigravity',
      displayName: '反重力猫',
      alternatives: [{ mention: '@opus', displayName: '布偶猫' }],
    };

    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify(routingError),
    });

    const result = await callbackPost('/api/callbacks/create-task', {
      title: 'test',
      ownerCatId: 'antigravity',
    });

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(
      text.startsWith('Cat routing failed [kind=cat_disabled]'),
      `should start with prefix: ${text.slice(0, 80)}`,
    );
    assert.ok(text.includes('@antigravity'), `should include target: ${text.slice(0, 120)}`);
    assert.ok(text.includes('"kind":"cat_disabled"'), `should include raw JSON: ${text.slice(0, 200)}`);
  });
});
