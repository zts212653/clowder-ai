import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('cat_cafe_cross_post_message assign_work retry identity', () => {
  let originalEnv;
  let originalFetch;
  let outboxDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-test';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-cross-post-retry-test-${Date.now()}-${Math.random()}`);
    mkdirSync(outboxDir, { recursive: true });
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outboxDir;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    if (outboxDir && existsSync(outboxDir)) rmSync(outboxDir, { recursive: true, force: true });
  });

  it('forwards the explicit stable retry key with the proposed action', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'dp-1', status: 'proposal_created' }) };
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: '@sonnet\nPlease take this work',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      clientMessageId: 'assign-work-review-42',
      proposedAction: {
        subjectRef: 'pr:owner/repo#42',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
      },
    });

    assert.equal(result.isError, undefined);
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.clientMessageId, 'assign-work-review-42');
    assert.equal(body.proposedAction.actionFamily, 'review');
  });

  it('fails closed before transport when assign_work has no proposed action', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('unexpected transport');
    };

    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: '@sonnet\nPlease take this work',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      clientMessageId: 'assign-work-review-42',
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires proposedAction/);
    assert.equal(fetchCalls, 0);
  });
});
