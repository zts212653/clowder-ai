/**
 * F193 Phase A — AC-A2: post_message MCP handler rejects threadId from
 * invocation-token caller (KD-1 enforcement at MCP layer).
 *
 * Boundary (KD-1):
 *  - invocation-token caller (no agentKeyCatId): threadId MUST be omitted —
 *    use cross_post_message for cross-thread delivery (F043 #316 防误投)
 *  - agent-key caller (F178): threadId is REQUIRED (no default thread context)
 *
 * MCP layer reject = early failure. Caller sees actionable error pointing to
 * cross_post_message; no callback HTTP request issued.
 *
 * SAFETY (LL-2026-05-07): MUST mock fetch + override callback env vars in
 * beforeEach. Without mocks, "without threadId" / "agent-key" cases would
 * dispatch real HTTP to whatever CAT_CAFE_API_URL points at (e.g. runtime
 * production at 3003/3004), spamming the user thread with test payloads.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('F193 AC-A2: post_message MCP handler rejects invocation-token + threadId', () => {
  let originalEnv;
  let originalFetch;
  let credentialDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Point at a closed loopback port so even if fetch mock is bypassed,
    // requests get ECONNREFUSED rather than reaching the user runtime.
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    credentialDir = join(tmpdir(), `cat-cafe-kd1-credential-${Date.now()}-${Math.random()}`);
    mkdirSync(credentialDir, { recursive: true });

    originalFetch = globalThis.fetch;
    // Default mock — every test invokes handlePostMessage; without this mock
    // the test would hit real HTTP and spam the user thread.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    rmSync(credentialDir, { recursive: true, force: true });
  });

  test('invocation-token caller passing threadId is rejected with cross_post_message hint', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handlePostMessage({
      content: 'hi',
      threadId: 'thread-other',
      // no agentKeyCatId — invocation-token path
    });
    assert.equal(result.isError, true, 'must reject with isError=true');
    const text = result.content[0].text;
    assert.ok(text.includes('cat_cafe_cross_post_message'), `error must hint at cross_post_message, got: ${text}`);
    assert.equal(
      fetchCalled,
      false,
      'KD-1 guard must reject EARLY — no HTTP dispatch when invocation-token caller passes threadId',
    );
  });

  test('pooled invocation credentials in a refresh file still reject threadId', async () => {
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    const credentialFile = join(credentialDir, 'pooled.json');
    writeFileSync(credentialFile, JSON.stringify({ invocationId: 'pooled-invocation', callbackToken: 'pooled-token' }));
    process.env.CAT_CAFE_CREDENTIAL_FILE = credentialFile;

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handlePostMessage({ content: 'hi', threadId: 'thread-other' });

    assert.equal(result.isError, true, 'credential-file invocation caller must remain subject to KD-1');
    assert.match(result.content[0].text, /cat_cafe_cross_post_message/);
    assert.equal(fetchCalled, false, 'KD-1 must reject before the callback request');
  });

  test('invocation-token caller without threadId is NOT rejected by KD-1 guard', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handlePostMessage({ content: 'hi' });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('use cat_cafe_cross_post_message for cross-thread'),
        `no-threadId path must not trigger KD-1 guard, got: ${text}`,
      );
    }
  });

  test('agent-key caller (no invocation env) passing threadId is NOT rejected by KD-1 guard', async () => {
    // F178: agent-key principal has no default thread, threadId is REQUIRED.
    // Principal detection follows buildAuthHeaders precedence — if env has
    // BOTH invocation_id and callback_token, request is invocation-token.
    // To exercise the agent-key path we must unset invocation creds.
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handlePostMessage({
      content: 'hi',
      threadId: 'thread-target',
      agentKeyCatId: 'antigravity',
    });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('use cat_cafe_cross_post_message for cross-thread'),
        `agent-key path must not trigger KD-1 guard, got: ${text}`,
      );
    }
  });

  test('P1 regression (codex review): invocation-token caller cannot bypass guard by passing agentKeyCatId', async () => {
    // Closing 砚砚 review P1: previous guard checked input.agentKeyCatId,
    // which is a sidecar selector field, NOT the auth principal. An
    // invocation-token caller passing input.agentKeyCatId would bypass the
    // guard and emit a request with x-invocation-id headers + threadId,
    // exactly what F043 #316 防误投 forbids.
    //
    // Fix: guard gates on env vars (the same precedence buildAuthHeaders
    // uses). With invocation creds present, threadId is rejected regardless
    // of input.agentKeyCatId.
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handlePostMessage({
      content: 'sneaky cross-thread',
      threadId: 'thread-other',
      agentKeyCatId: 'antigravity', // forged sidecar — must NOT exempt the guard
    });
    assert.equal(result.isError, true, 'invocation-token caller forging agentKeyCatId must still be rejected');
    const text = result.content[0].text;
    assert.ok(text.includes('cat_cafe_cross_post_message'), `must hint cross_post_message, got: ${text}`);
    assert.equal(fetchCalled, false, 'guard must reject EARLY — no HTTP dispatch when invocation creds in env');
  });

  test('same-thread single action forwards structured successor metadata', async () => {
    let posted;
    globalThis.fetch = async (_url, init) => {
      posted = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const action = {
      subjectRef: 'pr:owner/repo#2915',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    };
    const result = await handlePostMessage({
      content: 'Please review PR #2915',
      targetCats: ['codex'],
      clientMessageId: 'review-2915',
      action,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(posted.action, action);
    assert.equal(posted.clientMessageId, 'review-2915');
    assert.deepEqual(posted.targetCats, ['codex']);
  });

  test('same-thread action rejects parallel mode before HTTP and points to multi_mention', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handlePostMessage({
      content: 'Parallel review',
      targetCats: ['codex', 'gpt52'],
      clientMessageId: 'parallel-2915',
      action: {
        subjectRef: 'pr:owner/repo#2915',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        parallelIntent: 'independent reviews',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /multi_mention/);
    assert.equal(fetchCalled, false);
  });

  test('same-thread action requires explicit clientMessageId and exactly one target', async () => {
    const { handlePostMessage } = await import('../dist/tools/callback-tools.js');
    const action = {
      subjectRef: 'pr:owner/repo#2915',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    };

    const missingId = await handlePostMessage({ content: 'Review', targetCats: ['codex'], action });
    assert.equal(missingId.isError, true);
    assert.match(missingId.content[0].text, /clientMessageId/);

    const missingTarget = await handlePostMessage({ content: 'Review', clientMessageId: 'review-2915', action });
    assert.equal(missingTarget.isError, true);
    assert.match(missingTarget.content[0].text, /targetCats/);
  });
});
