/**
 * invoke-single-cat Tests
 * P1 fix: audit should emit CAT_ERROR when error was yielded during stream
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it, mock } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

// Shared temp dir — singleton EventAuditLog only initializes once
let tempDir;
let invokeSingleCat;

describe('invokeSingleCat audit events (P1 fix)', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-audit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    // Dynamic import AFTER env is set — singleton will use this dir
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  function makeDeps() {
    let counter = 0;
    return {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };
  }

  it('emits CAT_ERROR audit when service yields error before done', async () => {
    const errorService = {
      async *invoke() {
        yield { type: 'error', catId: 'codex', error: 'CLI 异常退出 (code: 1)', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: errorService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-error',
        isLastCat: true,
      }),
    );

    assert.ok(
      msgs.some((m) => m.type === 'error'),
      'error should be yielded',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'done should be yielded',
    );

    // Wait for fire-and-forget audit writes
    await new Promise((r) => setTimeout(r, 150));

    const files = await readdir(tempDir);
    const auditContent = await readFile(join(tempDir, files[0]), 'utf-8');
    const events = auditContent
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const threadEvents = events.filter((e) => e.threadId === 'thread-error');

    const responded = threadEvents.filter((e) => e.type === 'cat_responded');
    const catError = threadEvents.filter((e) => e.type === 'cat_error');

    assert.equal(responded.length, 0, 'should NOT have cat_responded when errors occurred');
    assert.ok(catError.length > 0, 'should have cat_error event');
    assert.ok(catError[0].data.error.includes('CLI'), 'cat_error should contain error message');
  });

  it('persists task progress snapshot with completed status on done', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const deps = { ...makeDeps(), taskProgressStore: store };

    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'completed' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-progress-done',
        isLastCat: true,
      }),
    );

    const snap = await store.getSnapshot('thread-progress-done', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'completed');
  });

  it('emits invocationId on task_progress system_info payloads', async () => {
    const deps = makeDeps();
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-progress-invocation-id',
        isLastCat: true,
      }),
    );

    const taskProgressMsg = msgs.find((m) => {
      if (m.type !== 'system_info' || !m.content) return false;
      try {
        return JSON.parse(m.content).type === 'task_progress';
      } catch {
        return false;
      }
    });
    assert.ok(taskProgressMsg, 'should include task_progress system_info');

    const payload = JSON.parse(taskProgressMsg.content);
    assert.equal(payload.type, 'task_progress');
    assert.equal(payload.invocationId, 'inv-1');
  });

  it('persists task progress snapshot with completed status on done even when tasks are not all completed', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const deps = { ...makeDeps(), taskProgressStore: store };

    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-progress-done-partial',
        isLastCat: true,
      }),
    );

    const snap = await store.getSnapshot('thread-progress-done-partial', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'completed');
  });

  it('persists task progress snapshot with interrupted status on error', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const deps = { ...makeDeps(), taskProgressStore: store };

    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'error', catId: 'codex', error: 'killed', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-progress-error',
        isLastCat: true,
      }),
    );

    const snap = await store.getSnapshot('thread-progress-error', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'interrupted');
  });

  it('does not emit user-visible error when taskProgressStore finalize write fails (should degrade)', async () => {
    const store = {
      async setSnapshot(snap) {
        if (snap.status !== 'running') throw new Error('finalize boom');
      },
      async getSnapshot() {
        return null;
      },
      async getThreadSnapshots() {
        return {};
      },
      async deleteSnapshot() {},
      async deleteThread() {},
    };

    const deps = { ...makeDeps(), taskProgressStore: store };
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-progress-finalize-throws',
        isLastCat: true,
      }),
    );

    assert.equal(msgs.filter((m) => m.type === 'error').length, 0, 'should not surface store failures as error');
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'done should still be yielded',
    );
  });

  it('finalize marks snapshot interrupted when invocation is aborted after progress (early iterator return)', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const deps = { ...makeDeps(), taskProgressStore: store };

    const ac = new AbortController();
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        // no done/error — simulating request abort / early close
      },
    };

    const it = invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user1',
      threadId: 'thread-progress-aborted',
      isLastCat: true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();

    // consume until we see task_progress so lastTasks is populated
    for (let i = 0; i < 5; i++) {
      const next = await it.next();
      assert.equal(next.done, false);
      if (next.value?.type === 'system_info') {
        try {
          const parsed = JSON.parse(next.value.content);
          if (parsed?.type === 'task_progress') break;
        } catch {
          // ignore
        }
      }
      if (i === 4) assert.fail('expected to receive task_progress before abort');
    }

    // abort and close early
    ac.abort();
    await it.return();

    const snap = await store.getSnapshot('thread-progress-aborted', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'interrupted');
    assert.equal(snap.interruptReason, 'aborted');
  });

  it('does not downgrade completed snapshot when abort happens after done (consumer closes iterator)', async () => {
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const store = new MemoryTaskProgressStore();
    const deps = { ...makeDeps(), taskProgressStore: store };

    const ac = new AbortController();
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const it = invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user1',
      threadId: 'thread-progress-abort-after-done',
      isLastCat: true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();

    let sawDone = false;
    for (let i = 0; i < 20; i++) {
      const next = await it.next();
      assert.equal(next.done, false);
      if (next.value?.type === 'done') {
        sawDone = true;
        break;
      }
    }
    assert.ok(sawDone, 'expected to see done before abort');

    ac.abort();
    await it.return();

    const snap = await store.getSnapshot('thread-progress-abort-after-done', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'completed');
    assert.equal(snap.interruptReason, undefined);
  });

  it('keeps completed status even if first finalize write fails then aborts after done', async () => {
    const store = (() => {
      const snaps = new Map();
      let failOnce = true;
      return {
        async setSnapshot(snap) {
          if (snap.status !== 'running' && failOnce) {
            failOnce = false;
            throw new Error('finalize boom once');
          }
          snaps.set(`${snap.threadId}:${snap.catId}`, snap);
        },
        async getSnapshot(threadId, catId) {
          return snaps.get(`${threadId}:${catId}`) ?? null;
        },
        async getThreadSnapshots() {
          return {};
        },
        async deleteSnapshot() {},
        async deleteThread() {},
      };
    })();

    const deps = { ...makeDeps(), taskProgressStore: store };
    const ac = new AbortController();
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({
            type: 'task_progress',
            catId: 'codex',
            tasks: [{ id: 't1', subject: 'A', status: 'in_progress' }],
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const it = invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user1',
      threadId: 'thread-progress-finalize-fails-then-abort',
      isLastCat: true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();

    // consume until done (first finalize will throw once)
    for (let i = 0; i < 20; i++) {
      const next = await it.next();
      assert.equal(next.done, false);
      if (next.value?.type === 'done') break;
      if (i === 19) assert.fail('expected to see done');
    }

    ac.abort();
    await it.return();

    const snap = await store.getSnapshot('thread-progress-finalize-fails-then-abort', 'codex');
    assert.ok(snap, 'snapshot should exist');
    assert.equal(snap.status, 'completed');
  });

  it('emits CAT_RESPONDED audit when service yields text + done (no errors)', async () => {
    const normalService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service: normalService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-normal',
        isLastCat: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 150));

    const files = await readdir(tempDir);
    const auditContent = await readFile(join(tempDir, files[0]), 'utf-8');
    const events = auditContent
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const threadEvents = events.filter((e) => e.threadId === 'thread-normal');

    const responded = threadEvents.filter((e) => e.type === 'cat_responded');
    const catError = threadEvents.filter((e) => e.type === 'cat_error');

    assert.ok(responded.length > 0, 'should have cat_responded for normal path');
    assert.equal(catError.length, 0, 'should NOT have cat_error for normal path');
  });

  it('F8: yields invocation_usage system_info when done has metadata.usage', async () => {
    const usageService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'answer', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'opus',
            usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.03 },
          },
        };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service: usageService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-usage',
        isLastCat: true,
      }),
    );

    const usageInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        const parsed = JSON.parse(m.content);
        return parsed.type === 'invocation_usage';
      } catch {
        return false;
      }
    });

    assert.equal(usageInfos.length, 1, 'should yield exactly one invocation_usage system_info');
    const payload = JSON.parse(usageInfos[0].content);
    assert.equal(payload.catId, 'opus');
    assert.equal(payload.usage.inputTokens, 1000);
    assert.equal(payload.usage.outputTokens, 500);
    assert.equal(payload.usage.costUsd, 0.03);
  });

  it('F8: does not yield invocation_usage when done has no usage', async () => {
    const noUsageService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service: noUsageService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-no-usage',
        isLastCat: true,
      }),
    );

    const usageInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        const parsed = JSON.parse(m.content);
        return parsed.type === 'invocation_usage';
      } catch {
        return false;
      }
    });

    assert.equal(usageInfos.length, 0, 'should not yield invocation_usage when no usage data');
  });

  it('F24: creates SessionRecord on session_init when sessionChainStore provided', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-sess-abc', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-init',
        isLastCat: true,
      }),
    );

    const active = sessionChainStore.getActive('opus', 'thread-f24-init');
    assert.ok(active, 'should have created an active SessionRecord');
    assert.equal(active.cliSessionId, 'cli-sess-abc');
    assert.equal(active.catId, 'opus');
    assert.equal(active.threadId, 'thread-f24-init');
    assert.equal(active.status, 'active');
  });

  it('F24: updates cliSessionId when session_init arrives for existing active record', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    // Pre-create an active session with old cliSessionId
    sessionChainStore.create({
      cliSessionId: 'old-cli',
      threadId: 'thread-f24-update',
      catId: 'opus',
      userId: 'user1',
    });

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'new-cli', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-update',
        isLastCat: true,
      }),
    );

    const active = sessionChainStore.getActive('opus', 'thread-f24-update');
    assert.ok(active);
    assert.equal(active.cliSessionId, 'new-cli', 'should have updated cliSessionId');
  });

  it('F24: yields context_health system_info when done has usage with contextWindowSize', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-health', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'answer', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 50000,
              outputTokens: 2000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-health',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        const parsed = JSON.parse(m.content);
        return parsed.type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1, 'should yield exactly one context_health system_info');
    const payload = JSON.parse(healthInfos[0].content);
    assert.equal(payload.catId, 'opus');
    assert.equal(payload.health.usedTokens, 50000);
    assert.equal(payload.health.windowTokens, 200000);
    assert.equal(payload.health.source, 'exact');
    assert.ok(payload.health.fillRatio > 0 && payload.health.fillRatio <= 1);
  });

  it('F24: uses fallback window size for models without contextWindowSize', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-fallback', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 100000,
              outputTokens: 1000,
              // no contextWindowSize — should use fallback
            },
          },
        };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-fallback',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1, 'should yield context_health with fallback window');
    const payload = JSON.parse(healthInfos[0].content);
    assert.equal(payload.health.windowTokens, 200000, 'should use fallback 200k for claude-opus-4-6');
    assert.equal(payload.health.source, 'approx', 'should mark as approx when using fallback');
  });

  it('F24: no context_health when model is unknown and no contextWindowSize', async () => {
    const service = {
      async *invoke() {
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'unknown',
            model: 'totally-unknown-model',
            usage: {
              inputTokens: 5000,
              outputTokens: 500,
            },
          },
        };
      },
    };

    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const deps = { ...makeDeps(), sessionChainStore: new SessionChainStore() };
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-unknown',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 0, 'should not yield context_health for unknown model without window');
  });

  it('F24: updates SessionRecord contextHealth on done', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-update-health', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 140000,
              outputTokens: 3000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-persist',
        isLastCat: true,
      }),
    );

    const active = sessionChainStore.getActive('opus', 'thread-f24-persist');
    assert.ok(active, 'should still have active session');
    assert.ok(active.contextHealth, 'session record should have contextHealth');
    assert.equal(active.contextHealth.usedTokens, 140000);
    assert.equal(active.contextHealth.windowTokens, 200000);
    assert.equal(active.contextHealth.fillRatio, 0.7);
    assert.equal(active.contextHealth.source, 'exact');
  });

  it('F24-fix: prefers lastTurnInputTokens over aggregated inputTokens for context health', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-last-turn', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 192000, // aggregated across 5 turns (WRONG for context health)
              lastTurnInputTokens: 44000, // last API call's actual input (CORRECT)
              outputTokens: 5000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore };
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-lastturn',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1);
    const payload = JSON.parse(healthInfos[0].content);
    // Should use lastTurnInputTokens (44000) not aggregated inputTokens (192000)
    assert.equal(
      payload.health.usedTokens,
      44000,
      'context health should use lastTurnInputTokens, not aggregated inputTokens',
    );
    assert.equal(payload.health.windowTokens, 200000);
    // fillRatio should be 44000/200000 = 0.22, not 192000/200000 = 0.96
    const expectedRatio = 44000 / 200000;
    assert.ok(
      Math.abs(payload.health.fillRatio - expectedRatio) < 0.001,
      `fillRatio should be ~${expectedRatio} (22%), got ${payload.health.fillRatio}`,
    );
  });

  it('F24-fix: falls back to inputTokens when lastTurnInputTokens is absent', async () => {
    const service = {
      async *invoke() {
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 50000, // no lastTurnInputTokens
              outputTokens: 2000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = makeDeps();
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-fallback',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1);
    const payload = JSON.parse(healthInfos[0].content);
    // Falls back to inputTokens since lastTurnInputTokens is absent
    assert.equal(
      payload.health.usedTokens,
      50000,
      'should fall back to inputTokens when lastTurnInputTokens is absent',
    );
  });

  it('F24: falls back to totalTokens when inputTokens are unavailable (totalTokens-only provider)', async () => {
    // Use codex to test totalTokens fallback path.
    // (F053: gemini now also has sessionChain=true, either cat would work here.)
    const service = {
      async *invoke() {
        yield {
          type: 'done',
          catId: 'codex',
          timestamp: Date.now(),
          metadata: {
            provider: 'openai',
            model: 'gpt-5.3-codex',
            usage: {
              totalTokens: 4200,
              // Simulate a provider that only returns total_tokens
            },
          },
        };
      },
    };

    const deps = makeDeps();
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-total-fallback',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1, 'should emit context_health from totalTokens fallback');
    const payload = JSON.parse(healthInfos[0].content);
    assert.equal(payload.catId, 'codex');
    assert.equal(payload.health.usedTokens, 4200);
    assert.equal(payload.health.source, 'approx');
  });

  it('F24: marks source as approx when usedTokens falls back to totalTokens despite exact window', async () => {
    // Use codex (sessionChain enabled) to test approx source detection.
    const service = {
      async *invoke() {
        yield {
          type: 'done',
          catId: 'codex',
          timestamp: Date.now(),
          metadata: {
            provider: 'openai',
            model: 'gpt-5.3-codex',
            usage: {
              totalTokens: 3000,
              contextWindowSize: 1_000_000,
            },
          },
        };
      },
    };

    const deps = makeDeps();
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-f24-total-source',
        isLastCat: true,
      }),
    );

    const healthInfos = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'context_health';
      } catch {
        return false;
      }
    });

    assert.equal(healthInfos.length, 1);
    const payload = JSON.parse(healthInfos[0].content);
    assert.equal(payload.health.usedTokens, 3000);
    assert.equal(payload.health.windowTokens, 1_000_000);
    assert.equal(payload.health.source, 'approx');
  });

  it('resume failure classification: maps missing session / cli exit / auth / invalid thinking signature / unknown', async () => {
    const { classifyResumeFailure } = await import('../dist/domains/cats/services/agents/invocation/invoke-helpers.js');

    assert.equal(classifyResumeFailure('No conversation found with session ID: stale-123'), 'missing_session');
    assert.equal(classifyResumeFailure('Gemini CLI: CLI 异常退出 (code: 1, signal: none)'), 'cli_exit');
    assert.equal(classifyResumeFailure('Gemini CLI: CLI 异常退出 (code: null, signal: SIGTERM)'), 'cli_exit');
    assert.equal(classifyResumeFailure('authentication failed: login required'), 'auth');
    assert.equal(
      classifyResumeFailure(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}',
      ),
      'invalid_thinking_signature',
    );
    assert.equal(classifyResumeFailure('upstream timeout'), null);
  });

  it('session self-heal: retries once without --resume when Claude reports missing conversation', async () => {
    let invokeCount = 0;
    const sessionDeletes = [];
    const sessionStores = [];
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options);
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'opus',
            error: 'No conversation found with session ID: bad-sess',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          return;
        }
        yield { type: 'session_init', catId: 'opus', sessionId: 'new-sess', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'recovered', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'bad-sess',
      store: async (_u, _c, _t, sid) => {
        sessionStores.push(sid);
      },
      delete: async (u, c, t) => {
        sessionDeletes.push(`${u}:${c}:${t}`);
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-retry',
        threadId: 'thread-retry',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'should re-invoke service once after stale session error');
    assert.equal(optionsSeen[0].sessionId, 'bad-sess', 'first attempt should include stored session');
    assert.equal(optionsSeen[1].sessionId, undefined, 'retry attempt should drop --resume session');
    assert.deepEqual(sessionDeletes, ['user-retry:opus:thread-retry'], 'should delete stale session before retry');
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'recovered'),
      'should recover and stream retry result',
    );
    assert.ok(
      msgs.some((m) => m.type === 'session_init' && m.sessionId === 'new-sess'),
      'should accept new session',
    );
    assert.equal(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('No conversation found')),
      false,
      'stale-session bootstrap error should be suppressed when retry succeeds',
    );
    assert.ok(sessionStores.includes('new-sess'), 'new session should be stored after recovery');
  });

  it('F118 P2-fix: self-heal retry clears cliSessionId from baseOptions', async () => {
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'opus',
            error: 'No conversation found with session ID: stale-sess',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'opus', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'stale-sess',
      store: async () => {},
      delete: async () => {},
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 't-p2-fix',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2);
    // First attempt should carry cliSessionId
    assert.equal(optionsSeen[0].cliSessionId, 'stale-sess', 'first attempt should have cliSessionId');
    // Retry after self-heal should NOT carry stale cliSessionId
    assert.equal(optionsSeen[1].cliSessionId, undefined, 'retry should clear cliSessionId');
  });

  it('F-BLOAT cloud P1: self-heal retry re-injects systemPrompt when session drops', async () => {
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'opus',
            error: 'No conversation found with session ID: stale-sess',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          return;
        }
        yield { type: 'session_init', catId: 'opus', sessionId: 'fresh-sess', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'recovered', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'stale-sess',
      store: async () => {},
      delete: async () => {},
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        systemPrompt: 'You are a helpful cat',
        userId: 'u1',
        threadId: 'thread-selfheal-prompt',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'should retry once');
    // First attempt: resume → systemPrompt skipped (canSkipOnResume + isResume)
    assert.equal(optionsSeen[0].sessionId, 'stale-sess', 'first attempt is resume');
    assert.equal(optionsSeen[0].systemPrompt, undefined, 'first attempt (resume) skips systemPrompt');
    // Second attempt: session dropped → fresh start → systemPrompt MUST be present
    assert.equal(optionsSeen[1].sessionId, undefined, 'retry drops session');
    assert.equal(
      optionsSeen[1].systemPrompt,
      'You are a helpful cat',
      'F-BLOAT cloud P1: self-heal retry must re-inject systemPrompt',
    );
  });

  it('session self-heal: does not retry on non-session errors', async () => {
    let invokeCount = 0;
    const sessionDeletes = [];
    const service = {
      async *invoke() {
        invokeCount++;
        yield { type: 'error', catId: 'opus', error: 'upstream timeout', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'sess-normal',
      store: async () => {},
      delete: async () => {
        sessionDeletes.push('deleted');
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-no-retry',
        threadId: 'thread-no-retry',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1, 'non-session errors should not trigger retry');
    assert.equal(sessionDeletes.length, 0, 'non-session errors should not clear session');
    assert.ok(msgs.some((m) => m.type === 'error' && String(m.error).includes('upstream timeout')));
  });

  async function withSanitizedOpencodeConfig(run) {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const registrySnapshot = catRegistry.getAllConfigs();
    const baselineConfigs = toAllCatConfigs(loadCatConfig(join(process.cwd(), '..', '..', 'cat-template.json')));
    const baselineOpencodeConfig = baselineConfigs.opencode;
    assert.ok(baselineOpencodeConfig, 'opencode config should exist in baseline catalog');

    const {
      accountRef: _ignoredAccountRef,
      providerProfileId: _ignoredProviderProfileId,
      ...sanitizedOpencodeConfig
    } = baselineOpencodeConfig;
    sanitizedOpencodeConfig.defaultModel = 'anthropic/claude-opus-4-6';

    catRegistry.reset();
    for (const [id, config] of Object.entries(baselineConfigs)) {
      if (id === 'opencode') {
        catRegistry.register(id, sanitizedOpencodeConfig);
      } else {
        catRegistry.register(id, config);
      }
    }

    try {
      return await run();
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
    }
  }

  it('opencode self-heal: retries once without --resume when resumed session hits prompt token limit', async () => {
    await withSanitizedOpencodeConfig(async () => {
      let invokeCount = 0;
      const sessionDeletes = [];
      const optionsSeen = [];
      const service = {
        async *invoke(_prompt, options) {
          optionsSeen.push(options);
          invokeCount++;
          if (invokeCount === 1) {
            yield {
              type: 'error',
              catId: 'opencode',
              error: 'prompt token count of 128625 exceeds the limit of 128000',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
            return;
          }
          yield { type: 'session_init', catId: 'opencode', sessionId: 'fresh-opencode-sess', timestamp: Date.now() };
          yield { type: 'text', catId: 'opencode', content: 'recovered', timestamp: Date.now() };
          yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
        },
      };

      const deps = makeDeps();
      deps.sessionManager = {
        get: async () => 'poisoned-opencode-sess',
        store: async () => {},
        delete: async (u, c, t) => {
          sessionDeletes.push(`${u}:${c}:${t}`);
        },
      };

      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opencode',
          service,
          prompt: 'test',
          userId: 'user-opencode-retry',
          threadId: 'thread-opencode-retry',
          isLastCat: true,
        }),
      );

      assert.equal(invokeCount, 2, 'should re-invoke service once after poisoned opencode session error');
      assert.equal(optionsSeen[0].sessionId, 'poisoned-opencode-sess', 'first attempt should include stored session');
      assert.equal(optionsSeen[1].sessionId, undefined, 'retry attempt should drop --resume session');
      assert.deepEqual(
        sessionDeletes,
        ['user-opencode-retry:opencode:thread-opencode-retry'],
        'should delete poisoned session before retry',
      );
      assert.ok(
        msgs.some((m) => m.type === 'text' && m.content === 'recovered'),
        'should recover and stream retry result',
      );
      assert.equal(
        msgs.some((m) => m.type === 'error' && String(m.error).includes('prompt token count')),
        false,
        'poisoned-session overflow error should be suppressed when retry succeeds',
      );
    });
  });

  it('opencode self-heal: does not retry prompt limit after content already streamed', async () => {
    await withSanitizedOpencodeConfig(async () => {
      let invokeCount = 0;
      const sessionDeletes = [];
      const service = {
        async *invoke() {
          invokeCount++;
          yield { type: 'text', catId: 'opencode', content: 'partial-output', timestamp: Date.now() };
          yield {
            type: 'error',
            catId: 'opencode',
            error: 'prompt token count of 128625 exceeds the limit of 128000',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
        },
      };

      const deps = makeDeps();
      deps.sessionManager = {
        get: async () => 'poisoned-opencode-sess',
        store: async () => {},
        delete: async (u, c, t) => {
          sessionDeletes.push(`${u}:${c}:${t}`);
        },
      };

      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opencode',
          service,
          prompt: 'test',
          userId: 'user-opencode-no-retry-after-output',
          threadId: 'thread-opencode-no-retry-after-output',
          isLastCat: true,
        }),
      );

      assert.equal(invokeCount, 1, 'must not retry after partial output to avoid duplicate side effects');
      assert.deepEqual(sessionDeletes, [], 'must not delete session when prompt-limit happens after content output');
      assert.ok(
        msgs.some((m) => m.type === 'text' && m.content === 'partial-output'),
        'already-streamed content should be preserved',
      );
      assert.ok(
        msgs.some((m) => m.type === 'error' && String(m.error).includes('prompt token count')),
        'prompt-limit error should surface when retry is unsafe',
      );
    });
  });

  it('opencode self-heal: flushes prompt limit error when invoke ends without done', async () => {
    await withSanitizedOpencodeConfig(async () => {
      let invokeCount = 0;
      const sessionDeletes = [];
      const service = {
        async *invoke() {
          invokeCount++;
          yield {
            type: 'error',
            catId: 'opencode',
            error: 'prompt token count of 128625 exceeds the limit of 128000',
            timestamp: Date.now(),
          };
        },
      };

      const deps = makeDeps();
      deps.sessionManager = {
        get: async () => 'poisoned-opencode-sess',
        store: async () => {},
        delete: async (u, c, t) => {
          sessionDeletes.push(`${u}:${c}:${t}`);
        },
      };

      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opencode',
          service,
          prompt: 'test',
          userId: 'user-opencode-no-done',
          threadId: 'thread-opencode-no-done',
          isLastCat: true,
        }),
      );

      assert.equal(invokeCount, 1, 'should not retry when the prompt-limit path never reaches done');
      assert.deepEqual(sessionDeletes, [], 'must not delete session when retry precondition was never met');
      assert.ok(
        msgs.some((m) => m.type === 'error' && String(m.error).includes('prompt token count')),
        'prompt-limit error must be surfaced instead of being swallowed',
      );
    });
  });

  it('transient CLI self-heal: retries once when Claude exits code 1 before any stream output', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'opus',
            error: 'Claude CLI: CLI 异常退出 (code: 1, signal: none)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'opus', content: 'retry-ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-transient-retry',
        threadId: 'thread-transient-retry',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'should retry once for transient code:1 exit');
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'retry-ok'),
      'retry result should be streamed',
    );
    assert.equal(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('CLI 异常退出')),
      false,
      'first-attempt transient CLI error should be suppressed when retry succeeds',
    );
  });

  it('transient CLI self-heal: does not retry when stream already produced text', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield { type: 'text', catId: 'opus', content: 'partial-output', timestamp: Date.now() };
        yield {
          type: 'error',
          catId: 'opus',
          error: 'Claude CLI: CLI 异常退出 (code: 1, signal: none)',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-no-transient-retry',
        threadId: 'thread-no-transient-retry',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1, 'must not retry after partial output to avoid duplication');
    assert.ok(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('CLI 异常退出')),
      'error should be preserved when partial output already streamed',
    );
  });

  it('resume failure stats: emits missing_session count after gemini self-heal success', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, _options) {
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'gemini',
            error: 'No conversation found with session ID: missing-1',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'gemini', content: 'retry-ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'missing-1',
      store: async () => {},
      delete: async () => {},
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'user-gemini-missing',
        threadId: 'thread-gemini-missing',
        isLastCat: true,
      }),
    );

    const statsMsg = msgs.find((m) => m.type === 'system_info' && m.content?.includes('"resume_failure_stats"'));
    assert.ok(statsMsg, 'should emit resume_failure_stats system_info');
    const payload = JSON.parse(statsMsg.content);
    assert.equal(payload.counts.missing_session, 1);
    assert.equal(payload.counts.cli_exit ?? 0, 0);
    assert.equal(payload.counts.auth ?? 0, 0);
  });

  it('resume failure stats: emits auth count and does not retry', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield {
          type: 'error',
          catId: 'gemini',
          error: 'authentication failed: please login',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'sess-auth',
      store: async () => {},
      delete: async () => {},
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'user-gemini-auth',
        threadId: 'thread-gemini-auth',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1, 'auth failure should not trigger retry');
    const statsMsg = msgs.find((m) => m.type === 'system_info' && m.content?.includes('"resume_failure_stats"'));
    assert.ok(statsMsg, 'should emit resume_failure_stats system_info');
    const payload = JSON.parse(statsMsg.content);
    assert.equal(payload.counts.auth, 1);
  });

  it('resume failure stats: emits cli_exit count for transient resume bootstrap exit', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'gemini',
            error: 'Gemini CLI: CLI 异常退出 (code: 1, signal: none)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'gemini', content: 'retry-ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'sess-cli-exit',
      store: async () => {},
      delete: async () => {},
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'user-gemini-cli-exit',
        threadId: 'thread-gemini-cli-exit',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'transient cli exit should retry once');
    const statsMsg = msgs.find((m) => m.type === 'system_info' && m.content?.includes('"resume_failure_stats"'));
    assert.ok(statsMsg, 'should emit resume_failure_stats system_info');
    const payload = JSON.parse(statsMsg.content);
    assert.equal(payload.counts.cli_exit, 1);
  });

  it('retries gemini invoke on transient resume bootstrap exit', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'gemini',
            error: 'Gemini CLI: CLI 异常退出 (code: 1, signal: none)',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          return;
        }
        yield { type: 'text', catId: 'gemini', content: 'retry-ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'sess-cli-exit-log',
      store: async () => {},
      delete: async () => {},
    };

    const results = await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'user-gemini-cli-exit-log',
        threadId: 'thread-gemini-cli-exit-log',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'should retry invoke after transient CLI exit');
    assert.ok(
      results.some((m) => m.type === 'text' && m.content === 'retry-ok'),
      'retry should yield successful text output',
    );
  });

  it('R7 P1: seal clears sessionManager BEFORE finalize completes (no race window)', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const sessionChainStore = new SessionChainStore();
    // Create a sealer whose finalize is slow (simulates async flush)
    let finalizeResolved = false;
    const realSealer = new SessionSealer(sessionChainStore);
    const sealer = {
      async requestSeal(opts) {
        return realSealer.requestSeal(opts);
      },
      async finalize(opts) {
        // Delay finalize to simulate transcript flush
        await new Promise((r) => setTimeout(r, 200));
        finalizeResolved = true;
        return realSealer.finalize(opts);
      },
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    // Track delete timing relative to finalize
    const timeline = [];
    const sessionDeletes = [];
    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer: sealer,
      sessionManager: {
        get: async () => 'old-sess',
        store: async () => {},
        delete: async (u, c, t) => {
          timeline.push({ event: 'delete', finalizeResolved });
          sessionDeletes.push(`${u}:${c}:${t}`);
        },
      },
    };

    // Service that triggers seal: 91% fill → opus threshold (90%)
    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'old-sess', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'answer', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 182000,
              outputTokens: 2000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-seal',
        threadId: 'thread-seal-race',
        isLastCat: true,
      }),
    );

    // sessionManager.delete should have been called BEFORE finalize completed
    assert.ok(sessionDeletes.length > 0, 'sessionManager.delete must be called on seal');
    assert.deepEqual(sessionDeletes, ['user-seal:opus:thread-seal-race']);
    assert.equal(timeline[0].event, 'delete');
    assert.equal(
      timeline[0].finalizeResolved,
      false,
      'sessionManager.delete must execute BEFORE finalize resolves (no race window)',
    );
  });

  it('R7 P1: next invocation after seal gets no sessionId (clean start)', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const sessionChainStore = new SessionChainStore();
    const sealer = new SessionSealer(sessionChainStore);

    // After delete, sessionManager.get returns undefined
    let stored = 'old-sess';
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: invokeCount === 1 ? 'old-sess' : 'new-sess',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: `answer-${invokeCount}`, timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: invokeCount === 1 ? 182000 : 5000,
              outputTokens: 1000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer: sealer,
      sessionManager: {
        get: async () => stored,
        store: async (_u, _c, _t, sid) => {
          stored = sid;
        },
        delete: async () => {
          stored = undefined;
        },
      },
    };

    // First invocation — triggers seal at 91%
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-seal-clean',
        isLastCat: true,
      }),
    );

    // Small delay to let async delete settle
    await new Promise((r) => setTimeout(r, 50));

    // Second invocation — should NOT have sessionId (old one was deleted)
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test2',
        userId: 'u1',
        threadId: 'thread-seal-clean',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2);
    assert.equal(optionsSeen[0].sessionId, 'old-sess', 'first call should use persisted session');
    assert.equal(
      optionsSeen[1].sessionId,
      undefined,
      'second call after seal must NOT resume old session (R7 P1 race fix)',
    );
  });

  it('R8 P1: slow sessionManager.delete cannot cause --resume race (read-side short-circuit)', async () => {
    // Scenario: seal triggers delete, but delete is slow (200ms).
    // Second invocation arrives BEFORE delete completes.
    // sessionManager.get() still returns old sessionId.
    // BUT: sessionChainStore.getActive() returns null (session is sealing/sealed)
    // → read-side short-circuit discards sessionId → no --resume.
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const sessionChainStore = new SessionChainStore();
    const sealer = new SessionSealer(sessionChainStore);

    // sessionManager.delete is intentionally slow — simulates Redis latency
    let stored = 'old-sess';
    let deleteStarted = false;
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        yield {
          type: 'session_init',
          catId: 'opus',
          sessionId: invokeCount === 1 ? 'old-sess' : 'new-sess',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: `answer-${invokeCount}`, timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: invokeCount === 1 ? 182000 : 5000,
              outputTokens: 1000,
              contextWindowSize: 200000,
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer: sealer,
      sessionManager: {
        get: async () => stored, // ALWAYS returns old value (delete is slow)
        store: async (_u, _c, _t, sid) => {
          stored = sid;
        },
        delete: async () => {
          deleteStarted = true;
          // Simulate very slow Redis delete — 500ms
          await new Promise((r) => setTimeout(r, 500));
          stored = undefined;
        },
      },
    };

    // First invocation — triggers seal at 91%
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-slow-delete',
        isLastCat: true,
      }),
    );

    // Delete has STARTED but NOT completed (it takes 500ms)
    assert.ok(deleteStarted, 'delete should have been initiated');
    // sessionManager.get() would still return 'old-sess' here

    // Second invocation — arrives while delete is still pending
    // Without read-side short-circuit, this would --resume into sealed session
    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test2',
        userId: 'u1',
        threadId: 'thread-slow-delete',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2);
    assert.equal(optionsSeen[0].sessionId, 'old-sess', 'first call uses persisted session');
    assert.equal(
      optionsSeen[1].sessionId,
      undefined,
      'second call must NOT resume despite slow delete — read-side short-circuit (R8 P1)',
    );
  });

  it('R9 P1: getChain() failure triggers fail-closed — no resume (not fail-open)', async () => {
    // Scenario: sessionManager.get() returns old sessionId, but
    // sessionChainStore.getChain() throws (Redis blip). The read-side
    // guard must be fail-closed: discard sessionId rather than risk
    // --resume into a sealed session.
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        yield { type: 'text', catId: 'opus', content: `answer-${invokeCount}`, timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    // sessionChainStore that always throws on getChain
    const failingChainStore = {
      getChain() {
        throw new Error('Redis connection lost');
      },
      getActive() {
        throw new Error('Redis connection lost');
      },
      get() {
        return null;
      },
      create() {
        return { id: 'x', seq: 0, status: 'active' };
      },
      update() {
        return {};
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore: failingChainStore,
      sessionManager: {
        get: async () => 'old-sess', // stale key still present
        store: async () => {},
        delete: async () => {},
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-chain-fail',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1);
    assert.equal(optionsSeen[0].sessionId, undefined, 'getChain() failure must discard sessionId (fail-closed, R9 P1)');
  });

  it('R11 P1-1: uses active record cliSessionId when it differs from sessionManager (RED)', async () => {
    // Scenario: sessionManager.get() returns 'cli-old' but the active SessionRecord
    // has cliSessionId='cli-new' (CLI restarted and session_init updated the record).
    // The invocation must use 'cli-new' for --resume, not 'cli-old'.
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        yield { type: 'text', catId: 'opus', content: `answer-${invokeCount}`, timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const activeRecord = {
      id: 'rec-1',
      seq: 0,
      status: 'active',
      cliSessionId: 'cli-new',
      catId: 'opus',
      threadId: 'thread-align',
      userId: 'u1',
    };

    const chainStore = {
      getChain: async () => [activeRecord],
      getActive: async () => activeRecord,
      get: async () => activeRecord,
      create: async () => activeRecord,
      update: async () => activeRecord,
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore: chainStore,
      sessionManager: {
        get: async () => 'cli-old', // stale value — doesn't match active record
        store: async () => {},
        delete: async () => {},
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-align',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1);
    assert.equal(
      optionsSeen[0].sessionId,
      'cli-new',
      'must use active record cliSessionId (authoritative), not stale sessionManager value',
    );
  });

  it('F33-fix: uses chain-bound cliSessionId even when sessionManager returns undefined', async () => {
    // Scenario: Frontend PATCH bind writes cliSessionId to SessionChainStore,
    // but sessionManager has no entry (bind doesn't write sessionManager).
    // invoke-single-cat must still read the chain and resume with bound ID.
    const optionsSeen = [];
    let invokeCount = 0;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push({ ...options });
        invokeCount++;
        yield { type: 'session_init', catId: 'opus', sessionId: 'bound-cli-session', timestamp: Date.now() };
        yield { type: 'text', catId: 'opus', content: 'resumed ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const boundRecord = {
      id: 'rec-bind',
      seq: 0,
      status: 'active',
      cliSessionId: 'bound-cli-session',
      catId: 'opus',
      threadId: 'thread-f33-bind',
      userId: 'u1',
    };

    const chainStore = {
      getChain: async () => [boundRecord],
      getActive: async () => boundRecord,
      get: async () => boundRecord,
      create: async () => boundRecord,
      update: async () => boundRecord,
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore: chainStore,
      sessionManager: {
        get: async () => undefined, // bind does NOT write sessionManager
        store: async () => {},
        delete: async () => {},
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-f33-bind',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 1);
    assert.equal(
      optionsSeen[0].sessionId,
      'bound-cli-session',
      'must use chain-bound cliSessionId even when sessionManager returns undefined',
    );
  });

  it('F053: gemini (sessionChain=true after parity fix) creates SessionRecord and participates in chain', async () => {
    let sessionRecordCreated = false;
    let transcriptWritten = false;

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'gemini', sessionId: 'gem-sess-1', timestamp: Date.now() };
        yield { type: 'text', catId: 'gemini', content: 'hello', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'gemini',
          timestamp: Date.now(),
          metadata: {
            usage: { totalTokens: 500000, contextWindowSize: 1000000 },
            model: 'gemini-3-pro',
          },
        };
      },
    };

    const activeRecord = { id: 'sr1', seq: 0, status: 'active', catId: 'gemini' };
    const chainStore = {
      getChain: async () => [],
      getActive: async () => (sessionRecordCreated ? activeRecord : null),
      create: async () => {
        sessionRecordCreated = true;
        return activeRecord;
      },
      update: async () => null,
    };
    const sealer = {
      requestSeal: async () => ({ accepted: false }),
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };
    const writer = {
      appendEvent: () => {
        transcriptWritten = true;
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore: chainStore,
      sessionSealer: sealer,
      transcriptWriter: writer,
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-toggle',
        isLastCat: true,
      }),
    );

    // F053: Gemini now has sessionChain=true, so it participates fully
    assert.equal(sessionRecordCreated, true, 'F053: Gemini SHOULD create SessionRecord now');
    assert.equal(transcriptWritten, true, 'F053: Gemini SHOULD write transcript now');

    // context_health system_info SHOULD be emitted now
    const contextHealthMsgs = msgs.filter(
      (m) => m.type === 'system_info' && m.content && m.content.includes('context_health'),
    );
    assert.ok(contextHealthMsgs.length > 0, 'F053: Gemini SHOULD emit context_health system_info now');
  });

  it('F24 toggle: opus (sessionChain=true by default) DOES create SessionRecord', async () => {
    let sessionRecordCreated = false;

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'opus-sess-1', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const chainStore = {
      getChain: async () => [],
      getActive: async () => null,
      create: async (input) => {
        sessionRecordCreated = true;
        return { id: 'sr2', seq: 0, status: 'active', catId: input.catId, cliSessionId: input.cliSessionId };
      },
      update: async () => null,
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore: chainStore,
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'u1',
        threadId: 'thread-toggle-on',
        isLastCat: true,
      }),
    );

    assert.equal(sessionRecordCreated, true, 'should create SessionRecord when sessionChain enabled');
  });

  // --- F-BLOAT: Resume skips systemPrompt injection ---

  it('F-BLOAT: skips systemPrompt on resume (sessionId present)', async () => {
    const promptsSeen = [];
    const optionsSeen = [];
    const service = {
      async *invoke(prompt, options) {
        promptsSeen.push(prompt);
        optionsSeen.push({ ...options });
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'existing-sess',
      store: async () => {},
      delete: async () => {},
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        systemPrompt: 'You are a cat',
        userId: 'u1',
        threadId: 'thread-bloat-resume',
        isLastCat: true,
      }),
    );

    assert.equal(optionsSeen[0].sessionId, 'existing-sess', 'should resume');
    assert.ok(!promptsSeen[0].includes('You are a cat'), 'F-BLOAT: systemPrompt should NOT be prepended on resume');
  });

  it('F-BLOAT: injects systemPrompt on new session (no sessionId)', async () => {
    const promptsSeen = [];
    const service = {
      async *invoke(prompt, _options) {
        promptsSeen.push(prompt);
        yield { type: 'text', catId: 'opus', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        systemPrompt: 'You are a cat',
        userId: 'u1',
        threadId: 'thread-bloat-new',
        isLastCat: true,
      }),
    );

    assert.ok(
      promptsSeen[0].includes('You are a cat'),
      'F-BLOAT: systemPrompt should be prepended to prompt on new session',
    );
    assert.ok(promptsSeen[0].includes('test'), 'F-BLOAT: original prompt should still be present');
  });

  it('F053: Gemini (sessionChain=true) skips systemPrompt on resume like other cats', async () => {
    const promptsSeen = [];
    const service = {
      async *invoke(prompt, _options) {
        promptsSeen.push(prompt);
        yield { type: 'text', catId: 'gemini', content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'gemini-sess-123',
      store: async () => {},
      delete: async () => {},
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        systemPrompt: 'You are a Siamese cat',
        userId: 'u1',
        threadId: 'thread-bloat-gemini',
        isLastCat: true,
      }),
    );

    // F053: Gemini now has sessionChain=true, so on resume it SKIPS
    // systemPrompt injection (same as Claude/Codex)
    assert.ok(
      !promptsSeen[0].includes('You are a Siamese cat'),
      'F053: Gemini should skip systemPrompt on resume (sessionChain=true)',
    );
  });

  it('F-BLOAT: compression detection flags re-injection when tokens drop >60%', async () => {
    // Reset compression detection state
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    mod._resetCompressionDetection();

    const promptsSeen = [];
    let callNum = 0;
    const service = {
      async *invoke(prompt, _options) {
        promptsSeen.push(prompt);
        callNum++;
        yield { type: 'session_init', catId: 'codex', sessionId: 'sess-compress', timestamp: Date.now() };
        yield { type: 'text', catId: 'codex', content: `answer-${callNum}`, timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          timestamp: Date.now(),
          metadata: {
            provider: 'openai',
            model: 'gpt-5.3-codex',
            usage: {
              inputTokens: callNum === 1 ? 60000 : 15000,
              outputTokens: 1000,
              contextWindowSize: 128000,
            },
          },
        };
      },
    };

    let stored = 'sess-compress';
    const deps = {
      ...makeDeps(),
      sessionManager: {
        get: async () => stored,
        store: async (_u, _c, _t, sid) => {
          stored = sid;
        },
        delete: async () => {
          stored = undefined;
        },
      },
    };

    // Turn 1: 60k tokens — establishes baseline
    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test1',
        systemPrompt: 'Identity prompt',
        userId: 'u1',
        threadId: 'thread-compress',
        isLastCat: true,
      }),
    );

    // Turn 2: 15k tokens (75% drop) — should flag re-injection for NEXT turn
    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test2',
        systemPrompt: 'Identity prompt',
        userId: 'u1',
        threadId: 'thread-compress',
        isLastCat: true,
      }),
    );

    // Turn 3: should have forceReinjection=true → systemPrompt injected despite resume
    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test3',
        systemPrompt: 'Identity prompt',
        userId: 'u1',
        threadId: 'thread-compress',
        isLastCat: true,
      }),
    );

    // Turn 1: resume (sessionId='sess-compress') → systemPrompt skipped
    // Turn 2: resume → systemPrompt skipped (compression detected AFTER this turn)
    // Turn 3: resume + forceReinjection → systemPrompt re-prepended
    assert.ok(!promptsSeen[0].includes('Identity prompt'), 'Turn 1 (resume): systemPrompt should NOT be prepended');
    assert.ok(!promptsSeen[1].includes('Identity prompt'), 'Turn 2 (resume): systemPrompt should NOT be prepended');
    assert.ok(
      promptsSeen[2].includes('Identity prompt'),
      'F-BLOAT: systemPrompt should be re-injected after compression detection',
    );

    mod._resetCompressionDetection();
  });

  it('session self-heal: retries at most once and surfaces error when retry still fails', async () => {
    let invokeCount = 0;
    const sessionDeletes = [];
    const service = {
      async *invoke() {
        invokeCount++;
        yield {
          type: 'error',
          catId: 'opus',
          error: 'No conversation found with session ID: still-bad',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => 'stale-sess',
      store: async () => {},
      delete: async () => {
        sessionDeletes.push('deleted');
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user-still-failing',
        threadId: 'thread-still-failing',
        isLastCat: true,
      }),
    );

    assert.equal(invokeCount, 2, 'should never retry more than once');
    assert.equal(sessionDeletes.length, 1, 'stale session should be cleared once before retry');
    assert.ok(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('No conversation found')),
      'should surface session error if retry still fails',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should still emit done',
    );
  });

  it('F127 P1: falls back to CAT_TEMPLATE_PATH project when thread projectPath is absent', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const templateRoot = await mkdtemp(join(tmpdir(), 'f127-active-template-'));
    await writeFile(join(templateRoot, 'cat-template.json'), '{}', 'utf-8');
    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = templateRoot;
    const boundProfile = await createProviderProfile(templateRoot, {
      provider: 'openai',
      name: 'template-bound-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.template.example',
      apiKey: 'sk-template-openai',
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(originalConfig, 'codex config should exist in registry');
    const boundCatId = 'codex-template-root-bound-profile';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      provider: 'openai',
      providerProfileId: boundProfile.id,
      defaultModel: 'gpt-5.4',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    try {
      process.env.CAT_TEMPLATE_PATH = join(templateRoot, 'cat-template.json');
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-active-template-fallback',
          threadId: 'thread-f127-active-template-fallback',
          isLastCat: true,
        }),
      );
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(templateRoot, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://api.template.example');
    assert.equal(callbackEnv.OPENAI_API_BASE, 'https://api.template.example');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-template-openai');
  });

  it('F127 P2: ignores unreadable CAT_TEMPLATE_PATH before switching account roots', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const staleTemplateRoot = await mkdtemp(join(tmpdir(), 'f127-stale-template-'));
    const isolatedRepoRoot = await mkdtemp(join(tmpdir(), 'f127-isolated-repo-'));
    const isolatedApiDir = join(isolatedRepoRoot, 'packages', 'api');
    await mkdir(isolatedApiDir, { recursive: true });
    await writeFile(join(isolatedRepoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = staleTemplateRoot;
    await createProviderProfile(staleTemplateRoot, {
      provider: 'openai',
      name: 'stale-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-stale-openai',
      setActive: false,
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    const previousCwd = process.cwd();
    try {
      process.chdir(isolatedApiDir);
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolatedRepoRoot;
      process.env.CAT_TEMPLATE_PATH = join(staleTemplateRoot, 'missing-template.json');
      await collect(
        invokeSingleCat(deps, {
          catId: 'codex',
          service,
          prompt: 'test',
          userId: 'user-f127-unreadable-template',
          threadId: 'thread-f127-unreadable-template',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      await rm(staleTemplateRoot, { recursive: true, force: true });
      await rm(isolatedRepoRoot, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127 P2: bootstrapped seed cats follow the current bootstrap binding after activation', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { activateProviderProfile, createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-seed-bootstrap-binding-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const templateRaw = await readFile(join(process.cwd(), '..', '..', 'cat-template.json'), 'utf-8');
    await writeFile(join(root, 'cat-template.json'), templateRaw, 'utf-8');

    // Isolate provider profiles to temp dir — prevents polluting real ~/.cat-cafe
    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    const activatedProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'activated-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.activated.example',
      apiKey: 'sk-activated-openai',
      setActive: false,
    });

    bootstrapCatCatalog(root, join(root, 'cat-template.json'));
    const catalogPath = resolveCatCatalogPath(root);
    const runtimeCatalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
    const codexBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'codex');
    assert.equal(codexBreed?.variants[0]?.accountRef, 'codex');

    await activateProviderProfile(root, 'openai', activatedProfile.id);

    const registrySnapshot = catRegistry.getAllConfigs();
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(catalogPath)))) {
      catRegistry.register(id, config);
    }

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: 'codex',
          service,
          prompt: 'test',
          userId: 'user-f127-seed-bootstrap-binding',
          threadId: 'thread-f127-seed-bootstrap-binding',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CODEX_AUTH_MODE, 'api_key');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-activated-openai');
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://api.activated.example');
    assert.equal(callbackEnv.OPENAI_API_BASE, 'https://api.activated.example');
  });

  it('F127 P1: prefers member-bound openai profile over protocol active profile', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-openai-profile-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    // Isolate provider profiles to temp dir — prevents polluting real ~/.cat-cafe
    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    await createProviderProfile(root, {
      provider: 'openai',
      name: 'global-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.global.example',
      apiKey: 'sk-global-openai',
      setActive: true,
    });
    const boundProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'bound-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.bound.example',
      apiKey: 'sk-bound-openai',
      models: ['gpt-5.4', 'claude-sonnet-4-6'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(originalConfig, 'codex config should exist in registry');
    const boundCatId = 'codex-bound-profile-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      provider: 'openai',
      providerProfileId: boundProfile.id,
      defaultModel: 'gpt-5.4',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-openai-bound',
          threadId: 'thread-f127-openai-bound',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CODEX_AUTH_MODE, 'api_key');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-bound-openai');
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://api.bound.example');
    assert.equal(callbackEnv.OPENAI_API_BASE, 'https://api.bound.example');
  });

  it('F127 P1: explicit builtin codex bindings force oauth callback env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f127-openai-builtin-oauth-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const originalCodexAuthMode = process.env.CODEX_AUTH_MODE;
    const originalOpenAIApiKey = process.env.OPENAI_API_KEY;
    const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
    const originalOpenAIApiBase = process.env.OPENAI_API_BASE;
    process.env.CODEX_AUTH_MODE = 'api_key';
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://api.global.example';
    process.env.OPENAI_API_BASE = 'https://api.global.example';

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(originalConfig, 'codex config should exist in registry');
    const boundCatId = 'codex-builtin-oauth-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      provider: 'openai',
      providerProfileId: 'codex',
      defaultModel: 'gpt-5.4',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-openai-builtin-oauth',
          threadId: 'thread-f127-openai-builtin-oauth',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      if (originalCodexAuthMode === undefined) delete process.env.CODEX_AUTH_MODE;
      else process.env.CODEX_AUTH_MODE = originalCodexAuthMode;
      if (originalOpenAIApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAIApiKey;
      if (originalOpenAIBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
      if (originalOpenAIApiBase === undefined) delete process.env.OPENAI_API_BASE;
      else process.env.OPENAI_API_BASE = originalOpenAIApiBase;
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CODEX_AUTH_MODE, 'oauth');
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127 P1: keeps env-based codex auth untouched when no openai profile is explicitly configured', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-openai-env-auth-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const registrySnapshot = catRegistry.getAllConfigs();
    const baselineConfigs = toAllCatConfigs(loadCatConfig(join(process.cwd(), '..', '..', 'cat-template.json')));
    const baselineCodexConfig = baselineConfigs.codex;
    assert.ok(baselineCodexConfig, 'codex config should exist in baseline catalog');
    const {
      accountRef: _ignoredAccountRef,
      providerProfileId: _ignoredProviderProfileId,
      ...sanitizedCodexConfig
    } = baselineCodexConfig;
    catRegistry.reset();
    for (const [id, config] of Object.entries(registrySnapshot)) {
      if (id === 'codex') {
        catRegistry.register(id, sanitizedCodexConfig);
      } else {
        catRegistry.register(id, config);
      }
    }

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: 'codex',
          service,
          prompt: 'test',
          userId: 'user-f127-openai-env-auth',
          threadId: 'thread-f127-openai-env-auth',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(Object.hasOwn(callbackEnv, 'CODEX_AUTH_MODE'), false);
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127: ignores legacy api_key protocol metadata when the member explicitly selected the client', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-bound-mismatch-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    const boundProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'bound-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.bound.example',
      apiKey: 'sk-bound-openai',
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-bound-mismatch-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      provider: 'opencode',
      providerProfileId: boundProfile.id,
      defaultModel: 'claude-sonnet-4-6',
    });

    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      const messages = await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-bound-mismatch',
          threadId: 'thread-f127-bound-mismatch',
          isLastCat: true,
        }),
      );
      assert.equal(invokeCount, 1, 'service.invoke should run when api_key profile is member-bound');
      assert.ok(messages.some((m) => m.type === 'done'));
      assert.equal(
        messages.some((m) => m.type === 'error' && /bound provider profile/i.test(String(m.error))),
        false,
      );
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('F127: injects OPENROUTER_API_KEY for opencode members bound to openai api_key profiles', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-openrouter-key-injection-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    const openrouterProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'openrouter-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-openrouter-key',
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-openrouter-bound-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      provider: 'opencode',
      providerProfileId: openrouterProfile.id,
      defaultModel: 'openrouter/google/gemini-3-flash-preview',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    try {
      process.chdir(apiDir);
      const messages = await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-openrouter-key-injection',
          threadId: 'thread-f127-openrouter-key-injection',
          isLastCat: true,
        }),
      );
      assert.ok(messages.some((m) => m.type === 'done'));
    } finally {
      process.chdir(previousCwd);
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_EFFECTIVE_PROTOCOL, 'openai');
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-openrouter-key');
    assert.equal(callbackEnv.OPENROUTER_API_KEY, 'sk-openrouter-key');
  });

  it('F062-fix: skips auto-seal for api_key mode when context health is approx', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f062-approx-no-seal-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'sponsor-gateway',
      mode: 'api_key',
      baseUrl: 'https://api.sponsor.example',
      apiKey: 'sk-sponsor',
      setActive: true,
    });

    const activeRecord = {
      id: 'sess-approx-no-seal',
      catId: 'opus',
      threadId: 'thread-f062-approx-no-seal',
      userId: 'user-f062-approx-no-seal',
      seq: 0,
      status: 'active',
      compressionCount: 0,
      cliSessionId: 'cli-approx-no-seal',
    };

    const sealRequests = [];
    const sessionChainStore = {
      getChain: async () => [activeRecord],
      getActive: async () => activeRecord,
      create: async () => activeRecord,
      update: async () => activeRecord,
    };
    const sessionSealer = {
      requestSeal: async (input) => {
        sealRequests.push(input);
        return { accepted: true, status: 'sealing' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-approx-no-seal', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              // Simulate non-standard gateway semantics where this value is
              // not a trustworthy "current context fill" signal.
              inputTokens: 195000,
              outputTokens: 10,
              // Intentionally omit contextWindowSize so source becomes approx.
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer,
    };

    const previousCwd = process.cwd();
    const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
    try {
      process.env.ANTHROPIC_PROXY_ENABLED = '0';
      process.chdir(apiDir);
      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'test',
          userId: 'user-f062-approx-no-seal',
          threadId: 'thread-f062-approx-no-seal',
          isLastCat: true,
        }),
      );

      const healthInfo = msgs.find((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'context_health';
        } catch {
          return false;
        }
      });
      assert.ok(healthInfo, 'should still emit context_health for observability');
      const healthPayload = JSON.parse(healthInfo.content);
      assert.equal(healthPayload.health.source, 'approx');

      const hasSealRequested = msgs.some((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'session_seal_requested';
        } catch {
          return false;
        }
      });
      assert.equal(hasSealRequested, false, 'should not emit session_seal_requested on approx api_key telemetry');
      assert.equal(sealRequests.length, 0, 'should not request seal on approx api_key telemetry');
    } finally {
      process.chdir(previousCwd);
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('F062-fix: skips auto-seal for api_key + compress strategy even when context health is exact', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const { _setTestStrategyOverride, _clearTestStrategyOverrides } = await import(
      '../dist/config/session-strategy.js'
    );
    _setTestStrategyOverride('opus', {
      strategy: 'compress',
      thresholds: { warn: 0.8, action: 0.9 },
      turnBudget: 12000,
      safetyMargin: 4000,
    });
    const root = await mkdtemp(join(tmpdir(), 'f062-exact-no-seal-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'sponsor-gateway',
      mode: 'api_key',
      baseUrl: 'https://api.sponsor.example',
      apiKey: 'sk-sponsor',
      setActive: true,
    });

    const activeRecord = {
      id: 'sess-exact-no-seal',
      catId: 'opus',
      threadId: 'thread-f062-exact-no-seal',
      userId: 'user-f062-exact-no-seal',
      seq: 0,
      status: 'active',
      compressionCount: 0,
      cliSessionId: 'cli-exact-no-seal',
    };

    const sealRequests = [];
    const sessionChainStore = {
      getChain: async () => [activeRecord],
      getActive: async () => activeRecord,
      create: async () => activeRecord,
      update: async () => activeRecord,
    };
    const sessionSealer = {
      requestSeal: async (input) => {
        sealRequests.push(input);
        return { accepted: true, status: 'sealing' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-exact-no-seal', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              // Simulate gateway telemetry that reports at/over window.
              inputTokens: 128211,
              outputTokens: 10,
              contextWindowSize: 128000,
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer,
    };

    const previousCwd = process.cwd();
    const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
    try {
      process.env.ANTHROPIC_PROXY_ENABLED = '0';
      process.chdir(apiDir);
      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'test',
          userId: 'user-f062-exact-no-seal',
          threadId: 'thread-f062-exact-no-seal',
          isLastCat: true,
        }),
      );

      const healthInfo = msgs.find((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'context_health';
        } catch {
          return false;
        }
      });
      assert.ok(healthInfo, 'should emit context_health for observability');
      const healthPayload = JSON.parse(healthInfo.content);
      assert.equal(healthPayload.health.source, 'exact');
      assert.equal(healthPayload.health.fillRatio, 1);

      const hasSealRequested = msgs.some((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'session_seal_requested';
        } catch {
          return false;
        }
      });
      assert.equal(hasSealRequested, false, 'should not emit session_seal_requested in api_key mode');
      assert.equal(sealRequests.length, 0, 'should not request seal in api_key mode');
    } finally {
      process.chdir(previousCwd);
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      _clearTestStrategyOverrides();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('F062-fix: keeps auto-seal for api_key + handoff strategy on exact budget overflow', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const { _setTestStrategyOverride, _clearTestStrategyOverrides } = await import(
      '../dist/config/session-strategy.js'
    );
    _setTestStrategyOverride('opus', {
      strategy: 'handoff',
      thresholds: { warn: 0.8, action: 0.9 },
      turnBudget: 12000,
      safetyMargin: 4000,
    });
    const root = await mkdtemp(join(tmpdir(), 'f062-exact-handoff-seal-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'sponsor-gateway',
      mode: 'api_key',
      baseUrl: 'https://api.sponsor.example',
      apiKey: 'sk-sponsor',
      setActive: true,
    });

    const activeRecord = {
      id: 'sess-exact-handoff-seal',
      catId: 'opus',
      threadId: 'thread-f062-exact-handoff-seal',
      userId: 'user-f062-exact-handoff-seal',
      seq: 0,
      status: 'active',
      compressionCount: 0,
      cliSessionId: 'cli-exact-handoff-seal',
    };

    const sealRequests = [];
    const sessionChainStore = {
      getChain: async () => [activeRecord],
      getActive: async () => activeRecord,
      create: async () => activeRecord,
      update: async () => activeRecord,
    };
    const sessionSealer = {
      requestSeal: async (input) => {
        sealRequests.push(input);
        return { accepted: true, status: 'sealing' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-exact-handoff-seal', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 128211,
              outputTokens: 10,
              contextWindowSize: 128000,
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionChainStore,
      sessionSealer,
    };

    const previousCwd = process.cwd();
    const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
    try {
      process.env.ANTHROPIC_PROXY_ENABLED = '0';
      process.chdir(apiDir);
      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'test',
          userId: 'user-f062-exact-handoff-seal',
          threadId: 'thread-f062-exact-handoff-seal',
          isLastCat: true,
        }),
      );

      const sealEvent = msgs.find((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'session_seal_requested';
        } catch {
          return false;
        }
      });
      assert.ok(sealEvent, 'should emit session_seal_requested in handoff mode');
      assert.equal(sealRequests.length, 1, 'should request seal in handoff mode');
    } finally {
      process.chdir(previousCwd);
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
      _clearTestStrategyOverrides();
      await rm(root, { recursive: true, force: true });
    }
  });
});
