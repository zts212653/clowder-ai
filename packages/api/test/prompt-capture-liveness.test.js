import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { PromptCaptureStore } from '../dist/infrastructure/debug/prompt-capture-store.js';

function capture(overrides = {}) {
  return {
    captureId: randomUUID(),
    invocationId: 'inv',
    catId: 'cat',
    threadId: 'thread',
    userId: 'owner',
    model: 'model',
    capturedAt: Date.now(),
    systemPrompt: '',
    userPrompt: '',
    effectivePrompt: 'x'.repeat(2 * 1024 * 1024),
    injectionDecision: { isResume: false, canSkipOnResume: false, forceReinjection: false, injected: false },
    promptBytes: 0,
    tokenEstimate: 0,
    ...overrides,
  };
}
test('R11: reading a compressed prompt yields, enforces owner/TTL and caps expanded bytes', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'prompt-liveness-'));
  try {
    const store = new PromptCaptureStore({ baseDir });
    const value = capture();
    store.captureSync(value);
    let yielded = false;
    const marker = yieldTurn().then(() => {
      yielded = true;
    });
    const result = await store.read(value.captureId, 'owner');
    assert.ok(yielded, 'payload read/decompression/parse blocked the API');
    assert.equal(result?.effectivePrompt, value.effectivePrompt);
    assert.equal(await store.read(value.captureId, 'foreign'), null);
    const expired = capture({ capturedAt: 1 });
    store.captureSync(expired);
    assert.equal(await store.read(expired.captureId, 'owner'), null);
    const bounded = new PromptCaptureStore({ baseDir, maxPayloadBytes: 1024 });
    assert.equal(await bounded.read(value.captureId, 'owner'), null);
    await marker;
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
test('R11: asynchronous append and prune serialize without losing a fresh capture', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'prompt-prune-'));
  try {
    const store = new PromptCaptureStore({ baseDir, maxEntries: 2 });
    store.captureSync(capture({ capturedAt: 1 }));
    const newest = capture({ effectivePrompt: 'fresh' });
    const pruning = store.prune();
    store.captureAsync(newest);
    await pruning;
    const entries = await store.listByInvocation('inv', 'owner');
    assert.ok(entries.some((entry) => entry.captureId === newest.captureId));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
