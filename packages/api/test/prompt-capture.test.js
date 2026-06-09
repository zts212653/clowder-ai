/**
 * F153 Prompt X-Ray: PromptCaptureStore + bridge tests.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const testDir = join(tmpdir(), `prompt-capture-test-${Date.now()}`);

function makeCapture(overrides = {}) {
  return {
    captureId: randomUUID(),
    invocationId: 'inv-001',
    catId: 'opus',
    threadId: 'thread-abc',
    userId: 'user-001',
    model: 'claude-opus-4-6',
    capturedAt: Date.now(),
    systemPrompt: 'You are a helpful cat.',
    missionPrefix: undefined,
    userPrompt: 'Hello world',
    effectivePrompt: 'You are a helpful cat.\n\n---\n\nHello world',
    injectionDecision: { isResume: false, canSkipOnResume: true, forceReinjection: false, injected: true },
    promptBytes: 42,
    tokenEstimate: 12,
    ...overrides,
  };
}

test('F153: PromptCaptureStore captures and reads back', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'basic');
  const store = new PromptCaptureStore({ baseDir: dir });

  const capture = makeCapture();
  store.captureSync(capture);

  const result = store.read(capture.captureId);
  assert.ok(result);
  assert.equal(result.catId, 'opus');
  assert.equal(result.effectivePrompt, capture.effectivePrompt);
  assert.equal(result.injectionDecision.injected, true);
});

test('F153: read returns null for missing capture', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'missing');
  const store = new PromptCaptureStore({ baseDir: dir });

  const result = store.read('nonexistent');
  assert.equal(result, null);
});

test('F153: listByInvocation filters correctly', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'by-inv');
  const store = new PromptCaptureStore({ baseDir: dir });

  store.captureSync(makeCapture({ invocationId: 'inv-A' }));
  store.captureSync(makeCapture({ invocationId: 'inv-B' }));
  store.captureSync(makeCapture({ invocationId: 'inv-A' }));

  const results = store.listByInvocation('inv-A');
  assert.equal(results.length, 2);
});

test('F153: listByThread filters correctly', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'by-thread');
  const store = new PromptCaptureStore({ baseDir: dir });

  store.captureSync(makeCapture({ threadId: 'thread-1' }));
  store.captureSync(makeCapture({ threadId: 'thread-2' }));
  store.captureSync(makeCapture({ threadId: 'thread-1' }));

  const results = store.listByThread('thread-1');
  assert.equal(results.length, 2);
});

test('F153: prune removes expired entries', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'prune');
  const store = new PromptCaptureStore({ baseDir: dir, ttlMs: 100 });

  store.captureSync(makeCapture({ capturedAt: Date.now() - 5000 }));
  store.captureSync(makeCapture({ capturedAt: Date.now() }));

  const removed = store.prune();
  assert.equal(removed, 1);
  assert.equal(store.stats().entries, 1);
});

test('F153: prune enforces maxEntries', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'max');
  const store = new PromptCaptureStore({ baseDir: dir, maxEntries: 3 });

  for (let i = 0; i < 5; i++) {
    store.captureSync(makeCapture());
  }

  store.prune();
  assert.ok(store.stats().entries <= 3);
});

test('F153: gzip compression actually compresses', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'gzip');
  const store = new PromptCaptureStore({ baseDir: dir });

  const bigPrompt = 'x'.repeat(10000);
  const capture = makeCapture({ effectivePrompt: bigPrompt });
  store.captureSync(capture);

  const filePath = join(dir, 'payloads', `${capture.captureId}.json.gz`);
  assert.ok(existsSync(filePath));
  const fileSize = readFileSync(filePath).length;
  assert.ok(fileSize < 5000, `Compressed size ${fileSize} should be much smaller than raw`);
});

// ── Gate tests ──────────────────────────────────────────────────

test('F153: isPromptCaptureEnabled respects env', async () => {
  const { isPromptCaptureEnabled } = await import('../dist/infrastructure/debug/prompt-capture-store.js');

  const origCapture = process.env.PROMPT_CAPTURE;
  const origCats = process.env.PROMPT_CAPTURE_CATS;

  process.env.PROMPT_CAPTURE = 'off';
  assert.equal(isPromptCaptureEnabled('opus'), false);

  process.env.PROMPT_CAPTURE = 'on';
  delete process.env.PROMPT_CAPTURE_CATS;
  assert.equal(isPromptCaptureEnabled('opus'), true);

  process.env.PROMPT_CAPTURE_CATS = 'codex,sonnet';
  assert.equal(isPromptCaptureEnabled('opus'), false);
  assert.equal(isPromptCaptureEnabled('codex'), true);

  // Restore
  if (origCapture !== undefined) process.env.PROMPT_CAPTURE = origCapture;
  else delete process.env.PROMPT_CAPTURE;
  if (origCats !== undefined) process.env.PROMPT_CAPTURE_CATS = origCats;
  else delete process.env.PROMPT_CAPTURE_CATS;
});

test('F153: estimateTokens gives reasonable estimate', async () => {
  const { estimateTokens } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const estimate = estimateTokens('Hello world, this is a test prompt');
  assert.ok(estimate > 5 && estimate < 20);
});

// ── Resource-level authorization ──────────────────────────────────

test('F153: read returns null for cross-user access', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'authz');
  const store = new PromptCaptureStore({ baseDir: dir });

  const capture = makeCapture({ userId: 'owner-123' });
  store.captureSync(capture);

  const resultOwner = store.read(capture.captureId, 'owner-123');
  assert.ok(resultOwner, 'Owner should be able to read their own capture');

  const resultOther = store.read(capture.captureId, 'other-456');
  assert.equal(resultOther, null, 'Other user should not be able to read capture');
});

test('F153: pre-fix captures without userId are denied (fail-closed)', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'authz-legacy');
  const store = new PromptCaptureStore({ baseDir: dir });

  const capture = makeCapture();
  delete capture.userId;
  store.captureSync(capture);

  const resultNoFilter = store.read(capture.captureId);
  assert.ok(resultNoFilter, 'Read without userId filter should succeed');

  const resultWithUser = store.read(capture.captureId, 'any-user');
  assert.equal(resultWithUser, null, 'Pre-fix capture without userId must be denied when userId filter is set');
});

test('F153: listByThread filters by userId', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'authz-list');
  const store = new PromptCaptureStore({ baseDir: dir });

  store.captureSync(makeCapture({ threadId: 'shared-thread', userId: 'alice' }));
  store.captureSync(makeCapture({ threadId: 'shared-thread', userId: 'bob' }));
  store.captureSync(makeCapture({ threadId: 'shared-thread', userId: 'alice' }));

  const aliceResults = store.listByThread('shared-thread', 20, 'alice');
  assert.equal(aliceResults.length, 2, 'Alice should only see her captures');

  const bobResults = store.listByThread('shared-thread', 20, 'bob');
  assert.equal(bobResults.length, 1, 'Bob should only see his captures');
});

// ── Source-level tests ──────────────────────────────────────────

test('F153: invoke-single-cat calls capturePromptIfEnabled', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(src.includes('capturePromptIfEnabled'), 'Should call capture function after effectivePrompt assembly');
  assert.ok(src.includes('prompt-capture-bridge'), 'Should import from prompt-capture-bridge');
});

test('F153: API routes registered in index.ts', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.ok(src.includes('promptCaptureRoutes'), 'Should register prompt capture routes');
});

// ── AC-G10 (Phase G native L0 closure / KD-44): backward + new field tests ──

test('AC-G10: PromptCapture without native L0 fields round-trips (backward compat)', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'ac-g10-legacy');
  const store = new PromptCaptureStore({ baseDir: dir });

  // Legacy shape — pre-AC-G10 captures never had nativeSystemPrompt /
  // totalTokenEstimate / captureDiagnostics. Must still load cleanly.
  const capture = makeCapture();
  store.captureSync(capture);
  const result = store.read(capture.captureId);
  assert.ok(result);
  assert.equal(result.nativeSystemPrompt, undefined, 'legacy capture must not invent native fields');
  assert.equal(result.totalTokenEstimate, undefined);
  assert.equal(result.captureDiagnostics, undefined);
});

test('AC-G10: PromptCapture with native L0 fields persists + reads back', async () => {
  const { PromptCaptureStore } = await import('../dist/infrastructure/debug/prompt-capture-store.js');
  const dir = join(testDir, 'ac-g10-native');
  const store = new PromptCaptureStore({ baseDir: dir });

  const capture = makeCapture({
    nativeSystemPrompt: 'COMPILED-L0-IDENTITY-RULES-GO-HERE',
    nativeSystemPromptSource: 'f203-l0',
    nativeSystemTokenEstimate: 1234,
    totalTokenEstimate: 1234 + 12, // nativeEst + msg tokenEstimate from makeCapture
  });
  store.captureSync(capture);
  const result = store.read(capture.captureId);
  assert.ok(result);
  assert.equal(result.nativeSystemPrompt, 'COMPILED-L0-IDENTITY-RULES-GO-HERE');
  assert.equal(result.nativeSystemPromptSource, 'f203-l0');
  assert.equal(result.nativeSystemTokenEstimate, 1234);
  assert.equal(result.totalTokenEstimate, 1246);
});

test('AC-G10: capture bridge stamps nativeSystemPrompt when nativeL0Provider=true (test fetcher)', async () => {
  // Force PROMPT_CAPTURE on for this test
  const prevEnv = process.env.PROMPT_CAPTURE;
  process.env.PROMPT_CAPTURE = 'on';
  try {
    const { capturePromptIfEnabled, getPromptCaptureStore } = await import(
      '../dist/infrastructure/debug/prompt-capture-bridge.js'
    );
    const _store = getPromptCaptureStore();
    const invocationId = `g10-native-${randomUUID()}`;
    capturePromptIfEnabled({
      catId: 'opus',
      invocationId,
      threadId: 'g10-thread',
      userId: 'g10-user',
      model: 'claude-opus-4-6',
      systemPrompt: 'pack-system',
      userPrompt: 'hi',
      effectivePrompt: 'pack-system\n\n---\n\nhi',
      injectionDecision: { isResume: false, canSkipOnResume: true, forceReinjection: false, injected: true },
      nativeL0Provider: true,
      nativeL0Fetcher: async () => 'TEST-COMPILED-L0',
    });
    // Capture is fire-and-forget async; poll the listByInvocation index.
    let captures = [];
    for (let i = 0; i < 50 && captures.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      captures = _store.listByInvocation(invocationId);
    }
    assert.equal(captures.length, 1, 'capture must be persisted within poll window');
    const detail = _store.read(captures[0].captureId);
    assert.ok(detail);
    assert.equal(detail.nativeSystemPrompt, 'TEST-COMPILED-L0');
    assert.equal(detail.nativeSystemPromptSource, 'f203-l0');
    assert.ok((detail.nativeSystemTokenEstimate ?? 0) > 0);
    assert.equal(detail.totalTokenEstimate, detail.tokenEstimate + (detail.nativeSystemTokenEstimate ?? 0));
    assert.equal(detail.captureDiagnostics, undefined, 'clean path must not record diagnostics');
  } finally {
    process.env.PROMPT_CAPTURE = prevEnv ?? '';
  }
});

test('AC-G10: capture bridge records captureDiagnostics when native L0 fetcher rejects (fail-safe)', async () => {
  const prevEnv = process.env.PROMPT_CAPTURE;
  process.env.PROMPT_CAPTURE = 'on';
  try {
    const { capturePromptIfEnabled, getPromptCaptureStore } = await import(
      '../dist/infrastructure/debug/prompt-capture-bridge.js'
    );
    const _store = getPromptCaptureStore();
    const invocationId = `g10-fail-${randomUUID()}`;
    capturePromptIfEnabled({
      catId: 'opus',
      invocationId,
      threadId: 'g10-fail-thread',
      userId: 'g10-fail-user',
      model: 'claude-opus-4-6',
      systemPrompt: 'pack-system',
      userPrompt: 'hi',
      effectivePrompt: 'pack-system\n\n---\n\nhi',
      injectionDecision: { isResume: false, canSkipOnResume: true, forceReinjection: false, injected: true },
      nativeL0Provider: true,
      // Fetcher fails — bridge must still write capture, just without native fields.
      nativeL0Fetcher: async () => {
        throw new Error('L0 compile blew up in test');
      },
    });
    let captures = [];
    for (let i = 0; i < 50 && captures.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      captures = _store.listByInvocation(invocationId);
    }
    assert.equal(captures.length, 1, 'capture must be persisted even when native fetch fails');
    const detail = _store.read(captures[0].captureId);
    assert.ok(detail);
    assert.equal(detail.nativeSystemPrompt, undefined, 'native fetch failure must not invent prompt');
    assert.ok(detail.captureDiagnostics);
    assert.equal(detail.captureDiagnostics.length, 1);
    assert.match(detail.captureDiagnostics[0], /native-l0-fetch-failed.*L0 compile blew up/);
  } finally {
    process.env.PROMPT_CAPTURE = prevEnv ?? '';
  }
});

test('AC-G10: nativeL0Provider=false (non-F203 provider) — native fields stay absent', async () => {
  const prevEnv = process.env.PROMPT_CAPTURE;
  process.env.PROMPT_CAPTURE = 'on';
  try {
    const { capturePromptIfEnabled, getPromptCaptureStore } = await import(
      '../dist/infrastructure/debug/prompt-capture-bridge.js'
    );
    const _store = getPromptCaptureStore();
    const invocationId = `g10-nonnative-${randomUUID()}`;
    capturePromptIfEnabled({
      catId: 'gemini',
      invocationId,
      threadId: 'g10-nonnative-thread',
      userId: 'g10-nonnative-user',
      model: 'gemini-pro',
      systemPrompt: 'full-system-via-pack',
      userPrompt: 'hi',
      effectivePrompt: 'full-system-via-pack\n\n---\n\nhi',
      injectionDecision: { isResume: false, canSkipOnResume: true, forceReinjection: false, injected: true },
      nativeL0Provider: false,
      // No fetcher — confirms bridge never tries to call it.
    });
    let captures = [];
    for (let i = 0; i < 50 && captures.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      captures = _store.listByInvocation(invocationId);
    }
    assert.equal(captures.length, 1);
    const detail = _store.read(captures[0].captureId);
    assert.ok(detail);
    assert.equal(detail.nativeSystemPrompt, undefined);
    assert.equal(detail.nativeSystemPromptSource, undefined);
    assert.equal(detail.nativeSystemTokenEstimate, undefined);
    assert.equal(detail.totalTokenEstimate, detail.tokenEstimate, 'no native L0 → total === msg estimate');
    assert.equal(detail.captureDiagnostics, undefined);
  } finally {
    process.env.PROMPT_CAPTURE = prevEnv ?? '';
  }
});

// Cleanup
test('F153: cleanup test dir', () => {
  rmSync(testDir, { recursive: true, force: true });
});
