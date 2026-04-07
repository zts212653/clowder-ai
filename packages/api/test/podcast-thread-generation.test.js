import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F091 Phase 6: Thread-based podcast generation tests.
 *
 * Tests the REAL production function `generateScriptViaThread` with
 * instrumented deps to verify invocation lifecycle correctness.
 */

describe('F091 Phase 6: PodcastRequest + ThreadInvokeDeps contract', () => {
  it('ThreadInvokeDeps type is exported from podcast-generator', async () => {
    const mod = await import('../dist/domains/signals/services/podcast-generator.js');
    assert.ok(mod.generatePodcastScript, 'generatePodcastScript should be exported');
    assert.ok(mod.generateScriptViaThread, 'generateScriptViaThread should be exported');
  });

  it('PodcastRouteOptions interface requires DI deps', async () => {
    const mod = await import('../dist/routes/signal-podcast-routes.js');
    assert.ok(mod.signalPodcastRoutes, 'signalPodcastRoutes should be exported');
  });
});

describe('F091 Phase 6: resolveStudyThread logic', () => {
  it('AC-P6-1: reuses existing thread from study meta', async () => {
    const { StudyMetaService } = await import('../dist/domains/signals/services/study-meta-service.js');
    const svc = new StudyMetaService();

    const testId = `test-resolve-${Date.now()}`;
    const testPath = '/tmp/test-resolve.md';

    await svc.linkThread(testId, testPath, {
      threadId: 'thread-existing',
      linkedBy: 'test-user',
    });

    const meta = await svc.readMeta(testId, testPath);
    assert.ok(meta.threads.length > 0, 'should have linked thread');
    assert.equal(meta.threads[0].threadId, 'thread-existing');
  });

  it('AC-P6-2: creates new thread when none exists', async () => {
    const { StudyMetaService } = await import('../dist/domains/signals/services/study-meta-service.js');
    const svc = new StudyMetaService();

    const testId = `test-no-thread-${Date.now()}`;
    const testPath = '/tmp/test-no-thread.md';

    const meta = await svc.readMeta(testId, testPath);
    assert.equal(meta.threads.length, 0, 'no threads for new article');
  });
});

// ── Helpers ──

const VALID_PODCAST_JSON = JSON.stringify({
  segments: [
    { speaker: '宪宪', text: '大家好', durationEstimate: 3 },
    { speaker: '砚砚', text: '你好', durationEstimate: 2 },
  ],
  totalDuration: 5,
});

/** Build instrumented fake deps that record every call. */
function buildFakeDeps(callLog, responseText = VALID_PODCAST_JSON) {
  return {
    messageStore: {
      append(msg) {
        callLog.push({ op: 'append', threadId: msg.threadId, catId: msg.catId });
        return { id: 'msg-001', ...msg };
      },
    },
    router: {
      async *routeExecution(_userId, _message, threadId, userMessageId, _targetCats, _intent, options) {
        callLog.push({
          op: 'routeExecution',
          threadId,
          userMessageId,
          hasSignal: !!options?.signal,
          signalAborted: !!options?.signal?.aborted,
        });
        yield { type: 'text', content: responseText };
      },
    },
    invocationRecordStore: {
      create(input) {
        callLog.push({ op: 'create', threadId: input.threadId });
        return { outcome: 'created', invocationId: 'inv-001' };
      },
      update(id, patch) {
        callLog.push({ op: 'update', id, ...patch });
        return {};
      },
    },
    invocationTracker: {
      start(_threadId, _userId, _cats) {
        callLog.push({ op: 'tracker.start' });
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete(_threadId, _controller) {
        callLog.push({ op: 'tracker.complete' });
      },
      completeAll() {},
    },
  };
}

function makeRequest(overrides = {}) {
  return {
    articleId: 'art-001',
    articleFilePath: '/tmp/test.md',
    articleTitle: 'Test Article',
    articleContent: 'Some content.',
    mode: 'essence',
    requestedBy: 'test-user',
    ...overrides,
  };
}

describe('F091 Phase 6: generateScriptViaThread — real production function', () => {
  it('P1-1: backfills userMessageId into invocation record', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildFakeDeps(callLog);

    await generateScriptViaThread(makeRequest(), 'thread-test', deps);

    const backfillCall = callLog.find((c) => c.op === 'update' && c.userMessageId !== undefined);
    assert.ok(backfillCall, 'must backfill userMessageId into invocation record');
    assert.equal(backfillCall.userMessageId, 'msg-001');

    // backfill must happen BEFORE 'running' status
    const backfillIdx = callLog.indexOf(backfillCall);
    const runningIdx = callLog.findIndex((c) => c.op === 'update' && c.status === 'running');
    assert.ok(runningIdx > backfillIdx, 'backfill must precede running status update');
  });

  it('P1-2: passes controller.signal into routeExecution options', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildFakeDeps(callLog);

    await generateScriptViaThread(makeRequest(), 'thread-signal', deps);

    const routeCall = callLog.find((c) => c.op === 'routeExecution');
    assert.ok(routeCall, 'routeExecution must be called');
    assert.equal(routeCall.hasSignal, true, 'must pass signal to routeExecution');
    assert.equal(routeCall.signalAborted, false, 'signal should not be pre-aborted');
  });

  it('full lifecycle call sequence is correct', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildFakeDeps(callLog);

    await generateScriptViaThread(makeRequest(), 'thread-seq', deps);

    const ops = callLog.map((c) => c.op);
    assert.deepEqual(ops, [
      'append', // ① post message
      'create', // ② create invocation record
      'update', // ②b backfill userMessageId
      'tracker.start', // ③ start tracker
      'update', // ④a status → running
      'routeExecution', // ④b invoke cat
      'update', // ④c status → succeeded
      'tracker.complete', // ⑤ cleanup
    ]);
  });

  it('failure path: tracker cleanup + failed status even when routeExecution throws', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const failDeps = buildFakeDeps(callLog);

    // Override router to throw
    failDeps.router = {
      async *routeExecution() {
        callLog.push({ op: 'routeExecution' });
        throw new Error('LLM unavailable');
      },
    };

    await assert.rejects(() => generateScriptViaThread(makeRequest(), 'thread-fail', failDeps), {
      message: 'LLM unavailable',
    });

    // Verify failed status was recorded
    const failUpdate = callLog.find((c) => c.op === 'update' && c.status === 'failed');
    assert.ok(failUpdate, 'must update record to failed');
    assert.equal(failUpdate.error, 'LLM unavailable');

    // Verify tracker was cleaned up
    const completeCall = callLog.find((c) => c.op === 'tracker.complete');
    assert.ok(completeCall, 'tracker.complete must be called in finally block');

    // No succeeded
    const succeedUpdate = callLog.find((c) => c.op === 'update' && c.status === 'succeeded');
    assert.equal(succeedUpdate, undefined, 'must NOT mark as succeeded on failure');
  });

  it('returns parsed PodcastScript on success', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildFakeDeps(callLog, VALID_PODCAST_JSON);

    const result = await generateScriptViaThread(makeRequest(), 'thread-result', deps);

    assert.ok(result, 'should return a PodcastScript');
    assert.ok(Array.isArray(result.segments), 'should have segments array');
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].speaker, '宪宪');
  });
});
