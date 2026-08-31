import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const VALID_PODCAST_JSON = JSON.stringify({
  segments: [
    { speaker: '宪宪', text: '大家好', durationEstimate: 3 },
    { speaker: '砚砚', text: '你好', durationEstimate: 2 },
  ],
  totalDuration: 5,
});

function makeRequest(overrides = {}) {
  return {
    articleId: 'art-001',
    articleFilePath: '/tmp/test.md',
    articleTitle: 'Test Article',
    articleContent: 'Some content.',
    mode: 'essence',
    requestedBy: 'test-user',
    threadId: 'thread-test',
    ...overrides,
  };
}

function buildQueueDeps(callLog, outcome = { status: 'succeeded', responseText: VALID_PODCAST_JSON }) {
  let completionHook;
  return {
    invocationQueue: {
      enqueue(input) {
        callLog.push({ op: 'enqueue', input });
        return {
          outcome: 'enqueued',
          entry: {
            id: 'podcast-entry-1',
            ...input,
            messageId: null,
            mergedMessageIds: [],
            status: 'queued',
            createdAt: 1,
          },
        };
      },
      getEntrySnapshot() {
        return null;
      },
      removeEntrySnapshotIfUnchanged() {
        return false;
      },
    },
    queueProcessor: {
      registerEntryCompleteHook(entryId, hook) {
        callLog.push({ op: 'register', entryId });
        completionHook = hook;
      },
      unregisterEntryCompleteHook(entryId) {
        callLog.push({ op: 'unregister', entryId });
        completionHook = undefined;
      },
      async requestDrain(threadId) {
        callLog.push({ op: 'drain', threadId });
        completionHook?.('podcast-entry-1', outcome.status, outcome.responseText);
      },
    },
  };
}

describe('F091 / RFC #1356: podcast Queue admission', () => {
  it('exports the Queue-backed generator and route', async () => {
    const generator = await import('../dist/domains/signals/services/podcast-generator.js');
    const routes = await import('../dist/routes/signal-podcast-routes.js');
    assert.ok(generator.generatePodcastScript);
    assert.ok(generator.generateScriptViaThread);
    assert.ok(routes.signalPodcastRoutes);
  });

  it('enqueues one private system input with no History source record', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildQueueDeps(callLog);

    await generateScriptViaThread(makeRequest(), 'thread-podcast', deps);

    const admission = callLog.find((call) => call.op === 'enqueue').input;
    assert.equal(admission.threadId, 'thread-podcast');
    assert.equal(admission.userId, 'test-user');
    assert.equal(admission.kind, 'private_input');
    assert.equal(admission.source, 'system');
    assert.equal(admission.messageId, undefined);
    assert.deepEqual(admission.targetCats, ['opus']);
    assert.equal(admission.autoExecute, true);
    assert.deepEqual(
      callLog.map((call) => call.op),
      ['enqueue', 'register', 'drain'],
    );
  });

  it('registers completion before draining so a fast provider cannot lose the result', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    await generateScriptViaThread(makeRequest(), 'thread-order', buildQueueDeps(callLog));
    assert.ok(callLog.findIndex((call) => call.op === 'register') < callLog.findIndex((call) => call.op === 'drain'));
  });

  it('returns the parsed completion-hook response', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const result = await generateScriptViaThread(makeRequest(), 'thread-result', buildQueueDeps([]));
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].speaker, '宪宪');
    assert.equal(result.totalDuration, 5);
  });

  it('propagates terminal Queue failure and releases the one-shot hook', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildQueueDeps(callLog, { status: 'failed', responseText: '' });
    await assert.rejects(() => generateScriptViaThread(makeRequest(), 'thread-fail', deps), {
      message: 'Podcast Queue execution failed',
    });
    assert.ok(callLog.some((call) => call.op === 'unregister'));
  });
});

describe('F091 Phase 6: study thread metadata', () => {
  it('reuses an existing thread link', async () => {
    const { StudyMetaService } = await import('../dist/domains/signals/services/study-meta-service.js');
    const svc = new StudyMetaService();
    const testId = `test-resolve-${Date.now()}`;
    const testPath = '/tmp/test-resolve.md';
    await svc.linkThread(testId, testPath, { threadId: 'thread-existing', linkedBy: 'test-user' });
    const meta = await svc.readMeta(testId, testPath);
    assert.equal(meta.threads[0].threadId, 'thread-existing');
  });
});
