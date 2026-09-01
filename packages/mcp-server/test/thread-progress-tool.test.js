import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_record_thread_progress', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-1';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-1';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('is discoverable, bounded and does not expose server-owned fields', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_record_thread_progress');
    assert.ok(tool);
    for (const forbidden of ['ownerUserId', 'threadId', 'actorCatId', 'occurredAt', 'id', 'sourceKey']) {
      assert.equal(forbidden in tool.inputSchema, false, `${forbidden} must be server-derived`);
    }
    assert.match(tool.description, /关键变化/);
    assert.match(tool.description, /无需写回|abstain/i);
    assert.match(tool.description, /co-creator.*主要交流语言/);
    assert.match(tool.description, /中英混合.*中文叙述.*技术名词.*保留原文/);
    assert.equal(tool.policy.activeState, 'canonical');
    assert.equal(
      tool.policy.standaloneReason.admissionRef,
      'file:docs/features/F308-thread-progress-receipts-and-briefs.md',
    );
  });

  test('posts one semantic receipt without callback credentials in the body', async () => {
    const { handleRecordThreadProgress } = await import('../dist/tools/callback-tools.js');
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ receiptId: 'receipt-1', inserted: true }) };
    };

    const result = await handleRecordThreadProgress({
      kind: 'milestone',
      impactAxes: ['verified_outcome'],
      headline: '完成 Receipt 存储与 callback',
      nextStep: '实现 ThreadBrief',
      provenance: [{ kind: 'invocation', invocationId: 'inv-1' }],
    });

    assert.equal(result.isError, undefined);
    assert.match(captured.url, /\/api\/callbacks\/record-thread-progress$/);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.invocationId, undefined);
    assert.equal(body.callbackToken, undefined);
    assert.equal(body.threadId, undefined);
    assert.equal(body.ownerUserId, undefined);
  });
});
