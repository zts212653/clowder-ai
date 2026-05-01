/**
 * invoke-single-cat Tests
 * P1 fix: audit should emit CAT_ERROR when error was yielded during stream
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

// Bun/npm child processes can briefly keep cache directories busy on macOS.
async function rmWithRetry(path, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
}

/**
 * F171: bootstrapCatCatalog() now creates empty catalogs (first-run quest).
 * Tests that call bootstrapCatCatalog() and then read catalog breeds must call
 * seedCatalogBreeds() afterwards to populate the catalog from the template.
 */
const BUILTIN_ACCOUNT_IDS = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
};

async function seedCatalogBreeds(projectRoot) {
  const templatePath = join(projectRoot, 'cat-template.json');
  const template = JSON.parse(await readFile(templatePath, 'utf-8'));
  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
  } catch {
    catalog = {};
  }
  const version = template.version ?? catalog.version ?? 1;
  const breeds = JSON.parse(JSON.stringify(template.breeds || []));
  for (const breed of breeds) {
    for (const variant of breed.variants || []) {
      if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
        variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
      }
    }
  }
  const roster = template.roster ?? catalog.roster ?? {};
  const reviewPolicy = template.reviewPolicy ??
    catalog.reviewPolicy ?? {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    };
  const seeded =
    version >= 2
      ? { version, breeds, roster, reviewPolicy, ...(template.coCreator ? { coCreator: template.coCreator } : {}) }
      : { version, breeds };
  await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf-8');
}

// Shared temp dir — singleton EventAuditLog only initializes once
let tempDir;
let invokeSingleCat;
let originalGlobalConfigRoot;
let originalHome;
let testGlobalConfigRoot;

before(() => {
  originalGlobalConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  originalHome = process.env.HOME;
});

beforeEach(async () => {
  // Provider profiles are global; each test gets its own isolated global store.
  testGlobalConfigRoot = await mkdtemp(join(tmpdir(), 'invoke-single-cat-global-'));
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = testGlobalConfigRoot;
  // Isolate homedir so the homedir migration doesn't pick up real ~/.cat-cafe/ files
  process.env.HOME = testGlobalConfigRoot;
  // clowder-ai#340: reset global accounts migration cache between tests
  const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');
  resetMigrationState();
});

afterEach(async () => {
  if (testGlobalConfigRoot) {
    await rmWithRetry(testGlobalConfigRoot);
    testGlobalConfigRoot = undefined;
  }
  if (originalGlobalConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = originalGlobalConfigRoot;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('invokeSingleCat audit events (P1 fix)', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-audit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    // Dynamic import AFTER env is set — singleton will use this dir
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  /** Save/restore CAT_CAFE_GLOBAL_CONFIG_ROOT to prevent test profiles leaking to ~/.cat-cafe/ */
  let _savedGlobalRoot;
  function setGlobalRoot(dir) {
    _savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = dir;
  }
  function restoreGlobalRoot() {
    if (_savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = _savedGlobalRoot;
  }

  function makeDeps() {
    let counter = 0;
    return {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
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

  it('stores route-state continuity capsule on SessionRecord during session_init', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { buildCapsuleFromRouteState } = await import(
      '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
    );
    const sessionChainStore = new SessionChainStore();
    const continuityCapsule = buildCapsuleFromRouteState({
      threadId: 'thread-f24-continuity',
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      directMessageFrom: 'codex',
      a2aTriggerMessageId: 'msg-current',
      a2aEnabled: true,
      a2aDepth: 1,
      maxA2ADepth: 15,
    });

    const service = {
      async *invoke() {
        yield { type: 'session_init', catId: 'opus', sessionId: 'cli-continuity', timestamp: Date.now() };
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
        threadId: 'thread-f24-continuity',
        isLastCat: true,
        continuityCapsule,
      }),
    );

    const active = sessionChainStore.getActive('opus', 'thread-f24-continuity');
    assert.ok(active, 'should have created an active SessionRecord');
    assert.deepEqual(active.continuityCapsule, continuityCapsule);
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

  it('ACP session: ephemeralSession=true skips seal on sessionId change', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const sessionChainStore = new SessionChainStore();
    const sealCalls = [];
    const sessionSealer = {
      requestSeal: async (args) => {
        sealCalls.push(args);
        return { accepted: true, status: 'sealing' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    // Pre-create active session (simulates first invocation)
    sessionChainStore.create({
      cliSessionId: 'acp-sess-1',
      threadId: 'thread-acp-seal',
      catId: 'gemini',
      userId: 'user1',
    });
    const originalId = sessionChainStore.getActive('gemini', 'thread-acp-seal').id;

    // Second invocation: ACP yields a DIFFERENT sessionId with ephemeralSession=true
    const service = {
      async *invoke() {
        yield {
          type: 'session_init',
          catId: 'gemini',
          sessionId: 'acp-sess-2',
          ephemeralSession: true,
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'gemini', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      },
    };

    const deps = { ...makeDeps(), sessionChainStore, sessionSealer };
    await collect(
      invokeSingleCat(deps, {
        catId: 'gemini',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-acp-seal',
        isLastCat: true,
      }),
    );

    // Session should NOT be sealed — just cliSessionId updated
    assert.equal(sealCalls.length, 0, 'should not have called requestSeal');
    const active = sessionChainStore.getActive('gemini', 'thread-acp-seal');
    assert.ok(active, 'original session should still be active');
    assert.equal(active.id, originalId, 'should be the SAME session record (not a new one)');
    assert.equal(active.cliSessionId, 'acp-sess-2', 'cliSessionId should be updated to new ACP session');
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
    assert.equal(
      classifyResumeFailure('no rollout found for session 019d3eca-9b77-7860-9e3f-1d4bb1815c5e'),
      'missing_session',
    );
    // End-to-end: formatted error from CodexAgentService with [missing_rollout] tag must classify as missing_session
    // This is the ACTUAL message invoke-single-cat receives after formatCliExitError propagates reasonCode
    const taggedMsg = 'Codex CLI: CLI 异常退出 (code: 1, signal: none) [missing_rollout]';
    assert.equal(classifyResumeFailure(taggedMsg), 'missing_session');
    // Priority: isMissingClaudeSessionError must win over isTransientCliExitCode1 for tagged messages
    const { isMissingClaudeSessionError, isTransientCliExitCode1 } = await import(
      '../dist/domains/cats/services/agents/invocation/invoke-helpers.js'
    );
    assert.equal(isMissingClaudeSessionError(taggedMsg), true, 'tagged message must be recognized as missing session');
    assert.equal(isTransientCliExitCode1(taggedMsg), true, 'tagged message also matches transient pattern');
    // In invoke-single-cat, isMissingClaudeSessionError is checked FIRST (line 1376) before
    // isTransientCliExitCode1 (line 1393), so missing_session takes priority → shouldRetryWithoutSession
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

  it('isTransientCliExitCode1: context-overflow messages must NOT be treated as transient (bug: Codex duplicate user turn in rollout)', async () => {
    const { isTransientCliExitCode1 } = await import(
      '../dist/domains/cats/services/agents/invocation/invoke-helpers.js'
    );

    // Real shape emitted by CodexAgentService.withRecentDiagnostics when session is context-full
    const contextOverflowMsg =
      "Codex CLI: CLI 异常退出 (code: 1, signal: none)\n最近流错误:\n- Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
    assert.equal(
      isTransientCliExitCode1(contextOverflowMsg),
      false,
      'context-window overflow is not recoverable — retrying writes a duplicate user turn into the rollout',
    );

    // Variant without the Chinese prefix (defensive matching on keyword only)
    const altMsg = 'CLI 异常退出 (code: 1, signal: none)\ncontext window exceeded';
    assert.equal(isTransientCliExitCode1(altMsg), false, 'context window phrase also non-transient');

    // Regression guard: bare transient exit with no overflow marker still retries
    assert.equal(
      isTransientCliExitCode1('Codex CLI: CLI 异常退出 (code: 1, signal: none)'),
      true,
      'vanilla transient exit without overflow marker must still be retryable',
    );
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

  it('self-heal fresh retry preserves continuity capsule when retry triggers threshold seal', async () => {
    const { buildCapsuleFromRouteState } = await import(
      '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
    );
    const activeRecord = {
      id: 'sess-retry-seal',
      catId: 'codex',
      threadId: 'thread-retry-seal',
      userId: 'user-retry-seal',
      seq: 0,
      status: 'active',
      compressionCount: 0,
    };
    let invokeCount = 0;
    const sealRequests = [];
    const service = {
      async *invoke() {
        invokeCount++;
        if (invokeCount === 1) {
          yield {
            type: 'error',
            catId: 'codex',
            error: 'No conversation found with session ID: stale-sess',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          return;
        }
        yield {
          type: 'done',
          catId: 'codex',
          timestamp: Date.now(),
          metadata: {
            provider: 'openai',
            model: 'gpt-5.5',
            usage: {
              inputTokens: 90000,
              outputTokens: 100,
              contextWindowSize: 100000,
            },
          },
        };
      },
    };

    const deps = {
      ...makeDeps(),
      sessionManager: {
        get: async () => 'stale-sess',
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      sessionChainStore: {
        getChain: async () => [activeRecord],
        getActive: async () => activeRecord,
        create: async () => activeRecord,
        update: async () => activeRecord,
      },
      sessionSealer: {
        requestSeal: async (input) => {
          sealRequests.push(input);
          return { accepted: true, status: 'sealing' };
        },
        finalize: async () => {},
        reconcileStuck: async () => 0,
        reconcileAllStuck: async () => 0,
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user-retry-seal',
        threadId: 'thread-retry-seal',
        isLastCat: true,
        continuityCapsule: buildCapsuleFromRouteState({
          threadId: 'thread-retry-seal',
          catId: 'codex',
          mode: 'independent',
          a2aEnabled: true,
        }),
      }),
    );

    assert.equal(invokeCount, 2, 'should retry once after stale session error');
    assert.equal(sealRequests.length, 1, 'retry attempt should still be eligible to seal');
    const sealEvent = msgs.find((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'session_seal_requested';
      } catch {
        return false;
      }
    });
    assert.ok(sealEvent, 'retry seal should emit session_seal_requested');
    const sealPayload = JSON.parse(sealEvent.content);
    assert.equal(sealPayload.continuityCapsule.threadId, 'thread-retry-seal');
    assert.equal(sealPayload.continuityCapsule.catId, 'codex');
    assert.equal(sealPayload.continuityCapsule.continuationReason, 'threshold_seal');
    assert.equal(sealPayload.continuityCapsule.seal.sessionId, 'sess-retry-seal');
    assert.equal(sealPayload.continuityDiagnostics.source, 'route_state');
    assert.equal(sealPayload.continuityDiagnostics.boundary, 'threshold_seal');
    assert.equal(sealPayload.continuityDiagnostics.persistedVia, 'session_seal_requested');
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
    const baselineConfigs = toAllCatConfigs(loadCatConfig(join(__dirname, '..', '..', '..', 'cat-template.json')));
    const baselineOpencodeConfig = baselineConfigs.opencode;
    assert.ok(baselineOpencodeConfig, 'opencode config should exist in baseline catalog');

    const { accountRef: _ignoredAccountRef, ...sanitizedOpencodeConfig } = baselineOpencodeConfig;
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

  it('transient CLI self-heal: does NOT retry when Codex error carries context-window overflow (prevents duplicate user turn)', async () => {
    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield {
          type: 'error',
          catId: 'codex',
          error:
            "Codex CLI: CLI 异常退出 (code: 1, signal: none)\n最近流错误:\n- Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user-codex-overflow',
        threadId: 'thread-codex-overflow',
        isLastCat: true,
      }),
    );

    assert.equal(
      invokeCount,
      1,
      'context-window overflow must NOT trigger retry — retry would duplicate the user turn in Codex rollout JSONL',
    );
    assert.ok(
      msgs.some((m) => m.type === 'error' && String(m.error).includes('ran out of room')),
      'context-overflow error must be surfaced to the user, not silently suppressed',
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

  it('F127 V-1: invokes a runtime-created cat in a new session with the refreshed roster', async () => {
    const originalConfigs = catRegistry.getAllConfigs();
    const promptsSeen = [];
    const service = {
      async *invoke(prompt) {
        promptsSeen.push(prompt);
        yield { type: 'text', catId: 'runtime-spark', content: 'runtime ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'runtime-spark', timestamp: Date.now() };
      },
    };

    try {
      catRegistry.register('runtime-spark', {
        ...originalConfigs.codex,
        id: 'runtime-spark',
        displayName: '火花猫',
        nickname: '小火花',
        mentionPatterns: ['@runtime-spark'],
        defaultModel: 'gpt-5.4-mini',
        roleDescription: '快速执行',
      });

      const msgs = await collect(
        invokeSingleCat(makeDeps(), {
          catId: 'runtime-spark',
          service,
          prompt: 'ping',
          systemPrompt: 'Roster includes @runtime-spark',
          userId: 'u1',
          threadId: 'thread-f127-runtime-new-session',
          isLastCat: true,
        }),
      );

      assert.match(promptsSeen[0], /Roster includes @runtime-spark/, 'new dynamic cat sessions must receive roster');
      assert.ok(
        msgs.some(
          (message) => message.type === 'text' && message.catId === 'runtime-spark' && message.content === 'runtime ok',
        ),
        'runtime-created cat should invoke and stream a normal response',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('F127 V-2: re-injects systemPrompt on resume when runtime cat registry changes', async () => {
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    mod._resetCompressionDetection();
    mod._resetStaticIdentityRegistryRevisionForTests?.();

    const originalConfigs = catRegistry.getAllConfigs();
    const promptsSeen = [];
    const optionsSeen = [];
    let storedSession;
    let callCount = 0;
    const service = {
      async *invoke(prompt, options) {
        promptsSeen.push(prompt);
        optionsSeen.push({ ...options });
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'session_init', catId: 'opus', sessionId: 'sess-f127-roster', timestamp: Date.now() };
        }
        yield { type: 'text', catId: 'opus', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    deps.sessionManager = {
      get: async () => storedSession,
      store: async (_userId, _catId, _threadId, sessionId) => {
        storedSession = sessionId;
      },
      delete: async () => {
        storedSession = undefined;
      },
    };

    try {
      await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'turn 1',
          systemPrompt: 'Roster v1',
          userId: 'u1',
          threadId: 'thread-f127-roster',
          isLastCat: true,
        }),
      );

      catRegistry.register('runtime-spark', {
        ...originalConfigs.codex,
        displayName: '火花猫',
        nickname: '小火花',
        mentionPatterns: ['@runtime-spark'],
        defaultModel: 'gpt-5.4-mini',
        roleDescription: '快速执行',
      });

      await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'turn 2',
          systemPrompt: 'Roster v2 includes @runtime-spark',
          userId: 'u1',
          threadId: 'thread-f127-roster',
          isLastCat: true,
        }),
      );

      assert.equal(optionsSeen[1].sessionId, 'sess-f127-roster', 'second turn must still resume existing CLI session');
      assert.match(
        promptsSeen[1],
        /Roster v2 includes @runtime-spark/,
        'runtime registry change must refresh roster even on resume',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
      mod._resetCompressionDetection();
      mod._resetStaticIdentityRegistryRevisionForTests?.();
    }
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
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const templateRoot = await mkdtemp(join(tmpdir(), 'f127-active-template-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = templateRoot;
    await writeFile(join(templateRoot, 'cat-template.json'), '{}', 'utf-8');
    setGlobalRoot(templateRoot);
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
      clientId: 'openai',
      accountRef: boundProfile.id,
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
      restoreGlobalRoot();
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(templateRoot);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://api.template.example');
    assert.equal(callbackEnv.OPENAI_API_BASE, 'https://api.template.example');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-template-openai');
  });

  it('F127 P2: ignores unreadable CAT_TEMPLATE_PATH before switching account roots', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const staleTemplateRoot = await mkdtemp(join(tmpdir(), 'f127-stale-template-'));
    const isolatedRepoRoot = await mkdtemp(join(tmpdir(), 'f127-isolated-repo-'));
    const isolatedApiDir = join(isolatedRepoRoot, 'packages', 'api');
    await mkdir(isolatedApiDir, { recursive: true });
    await writeFile(join(isolatedRepoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = staleTemplateRoot;
    await createProviderProfile(staleTemplateRoot, {
      provider: 'openai',
      name: 'stale-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-stale-openai',
      setActive: true,
    });
    // Switch global root to the isolated repo so the stale profile is invisible
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolatedRepoRoot;

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
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      await rmWithRetry(staleTemplateRoot);
      await rmWithRetry(isolatedRepoRoot);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127 P2: bootstrapped seed cats follow the current bootstrap binding after activation', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { activateProviderProfile, createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-seed-bootstrap-binding-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const templateRaw = await readFile(join(__dirname, '..', '..', '..', 'cat-template.json'), 'utf-8');
    await writeFile(join(root, 'cat-template.json'), templateRaw, 'utf-8');
    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
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
    // F171: bootstrapCatCatalog now creates empty catalogs; seed breeds from template.
    await seedCatalogBreeds(root);
    const catalogPath = resolveCatCatalogPath(root);
    const runtimeCatalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
    const codexBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'codex');
    assert.equal(codexBreed?.variants[0]?.accountRef, 'codex');

    // clowder-ai#340: "activation" = updating the catalog variant's accountRef binding.
    // The old activate API was a no-op; explicitly bind the variant instead.
    const codexVariant = codexBreed?.variants[0];
    if (codexVariant) codexVariant.accountRef = activatedProfile.id;
    await writeFile(catalogPath, JSON.stringify(runtimeCatalog, null, 2), 'utf-8');

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
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CODEX_AUTH_MODE, 'api_key');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-activated-openai');
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://api.activated.example');
    assert.equal(callbackEnv.OPENAI_API_BASE, 'https://api.activated.example');
  });

  it('keeps default Anthropic seed cats on builtin claude subscription when installer account coexists', async () => {
    const { bootstrapCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const root = await mkdtemp(join(tmpdir(), 'anthropic-seed-binding-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await mkdir(join(root, '.cat-cafe'), { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const templateRaw = await readFile(join(__dirname, '..', '..', '..', 'cat-template.json'), 'utf-8');
    await writeFile(join(root, 'cat-template.json'), templateRaw, 'utf-8');
    await writeFile(
      join(root, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        {
          claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
          'installer-anthropic': {
            authType: 'api_key',
            displayName: 'Installer Anthropic',
            baseUrl: 'https://proxy.example.dev',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(root, '.cat-cafe', 'credentials.json'),
      JSON.stringify(
        {
          'installer-anthropic': { apiKey: 'sk-installer-anthropic' },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const prevHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.HOME = root;
    bootstrapCatCatalog(root, join(root, 'cat-template.json'));
    // F171: bootstrapCatCatalog now creates empty catalogs; seed breeds from template.
    await seedCatalogBreeds(root);

    const registrySnapshot = catRegistry.getAllConfigs();
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(resolveCatCatalogPath(root))))) {
      catRegistry.register(id, config);
    }

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
    try {
      process.env.ANTHROPIC_PROXY_ENABLED = '0';
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: 'opus',
          service,
          prompt: 'test anthropic seed binding',
          userId: 'user-anthropic-seed-binding',
          threadId: 'thread-anthropic-seed-binding',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'subscription');
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY, undefined);
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL, undefined);
  });

  it('F127 P1: prefers member-bound openai profile over protocol active profile', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-openai-profile-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    setGlobalRoot(root);

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
      clientId: 'openai',
      accountRef: boundProfile.id,
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
    const previousEnvMcpPath = process.env.CAT_CAFE_MCP_SERVER_PATH;
    try {
      process.chdir(apiDir);
      delete process.env.CAT_CAFE_MCP_SERVER_PATH;
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
      restoreGlobalRoot();
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
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

    // clowder-ai#340: Seed builtin codex account in global accounts store
    const globalCatCafe = join(testGlobalConfigRoot, '.cat-cafe');
    await mkdir(globalCatCafe, { recursive: true });
    await writeFile(
      join(globalCatCafe, 'accounts.json'),
      JSON.stringify({ codex: { authType: 'oauth', protocol: 'openai' } }, null, 2),
      'utf-8',
    );

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
      clientId: 'openai',
      accountRef: 'codex',
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
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CODEX_AUTH_MODE, 'oauth');
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127 P1: keeps env-based codex auth untouched when no openai profile is explicitly configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f127-openai-env-auth-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const prevGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(originalConfig, 'codex config should exist in registry');
    const { accountRef: _accountRef, ...unboundConfig } = originalConfig;
    const unboundCatId = 'codex-env-auth-test';
    catRegistry.register(unboundCatId, {
      ...unboundConfig,
      id: unboundCatId,
      mentionPatterns: [`@${unboundCatId}`],
      clientId: 'openai',
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
          catId: unboundCatId,
          service,
          prompt: 'test',
          userId: 'user-f127-openai-env-auth',
          threadId: 'thread-f127-openai-env-auth',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      if (prevGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobalRoot;
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(Object.hasOwn(callbackEnv, 'CODEX_AUTH_MODE'), false);
    assert.equal(callbackEnv.OPENAI_API_KEY, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, undefined);
    assert.equal(callbackEnv.OPENAI_API_BASE, undefined);
  });

  it('F127 P1: preserves explicit bound-account failures instead of masking them as generic resolution errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f127-bound-account-missing-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('codex')?.config;
    assert.ok(originalConfig, 'codex config should exist in registry');
    const boundCatId = 'codex-missing-bound-account-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'openai',
      accountRef: 'missing-openai-account',
      defaultModel: 'gpt-5.4',
    });

    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
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
          prompt: 'test missing bound account',
          userId: 'user-f127-bound-account-missing',
          threadId: 'thread-f127-bound-account-missing',
          isLastCat: true,
        }),
      );

      assert.equal(invokeCount, 0, 'service.invoke should not run when the explicitly bound account is missing');
      assert.ok(messages.some((m) => m.type === 'done'));
      assert.ok(
        messages.some((m) => m.type === 'error' && m.error === 'bound account "missing-openai-account" not found'),
        'should preserve the specific bound-account failure',
      );
      assert.equal(
        messages.some((m) => m.type === 'error' && /failed to resolve bound account/i.test(String(m.error))),
        false,
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }
  });

  it('F127: ignores legacy api_key protocol metadata when the member explicitly selected the client', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-bound-mismatch-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    setGlobalRoot(root);

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
      clientId: 'opencode',
      accountRef: boundProfile.id,
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
      restoreGlobalRoot();
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }
  });

  it('clowder-ai#329: rejects api_key account with no API key before spawning child process', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f329-missing-apikey-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    // Create an api_key account WITHOUT providing an actual API key
    // (env fallback retired in #329 — no isolation needed)
    const noKeyProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'no-key-account',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.example.com',
      models: ['gpt-4o'],
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-no-key-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: noKeyProfile.id,
      defaultModel: 'gpt-4o',
    });

    let invokeCount = 0;
    const service = {
      async *invoke() {
        invokeCount++;
        yield { type: 'done', catId: boundCatId, timestamp: Date.now() };
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
          userId: 'user-f329-no-key',
          threadId: 'thread-f329-no-key',
          isLastCat: true,
        }),
      );
      assert.equal(invokeCount, 0, 'service.invoke must NOT be called when API key is missing');
      const errorMsg = messages.find((m) => m.type === 'error');
      assert.ok(errorMsg, 'must emit an error message');
      assert.match(String(errorMsg.error), /no API key set/i, 'error must mention missing API key');
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }
  });

  it('F127: injects OPENROUTER_API_KEY for opencode members bound to openai api_key profiles', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f127-openrouter-key-injection-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    setGlobalRoot(root);

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
      clientId: 'opencode',
      accountRef: openrouterProfile.id,
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
      restoreGlobalRoot();
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_EFFECTIVE_PROTOCOL, undefined);
    assert.equal(callbackEnv.OPENAI_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(callbackEnv.OPENAI_API_KEY, 'sk-openrouter-key');
    assert.equal(callbackEnv.OPENROUTER_API_KEY, 'sk-openrouter-key');
  });

  it('clowder-ai#223: unknown canonical provider/model without ocProviderName writes invocation-scoped OPENCODE_CONFIG and cleans it up', async () => {
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    mod._resetOpenCodeKnownModels(new Set(['anthropic/claude-opus-4-6']));
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f189-opencode-custom-provider-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const customProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'maas-openai',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://maas.example/v1',
      apiKey: 'sk-maas-key',
      models: ['maas/glm-5'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-maas-bound-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: customProfile.id,
      defaultModel: 'maas/glm-5',
    });

    const optionsSeen = [];
    let seenConfigPath;
    let seenRuntimeConfig;
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
        assert.ok(seenConfigPath, 'custom provider should receive OPENCODE_CONFIG');
        seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
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
          userId: 'user-f189-opencode-custom-provider',
          threadId: 'thread-f189-opencode-custom-provider',
          isLastCat: true,
        }),
      );
      assert.ok(messages.some((m) => m.type === 'done'));
    } finally {
      process.chdir(previousCwd);
      mod._resetOpenCodeKnownModels(null);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_EFFECTIVE_PROTOCOL, undefined);
    assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-maas-key');
    assert.equal(callbackEnv.CAT_CAFE_OC_BASE_URL, 'https://maas.example/v1');
    assert.equal(seenRuntimeConfig?.model, 'maas/glm-5');
    assert.equal(seenRuntimeConfig?.provider?.maas?.npm, '@ai-sdk/openai-compatible');
    assert.deepStrictEqual(seenRuntimeConfig?.provider?.maas?.models, { 'glm-5': { name: 'glm-5' } });
    await assert.rejects(readFile(seenConfigPath, 'utf-8'));
  });

  it('clowder-ai#223: bare model + provider assembles composite model for custom provider routing', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f189-oc-bare-model-'));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const customProfile = await createProviderProfile(root, {
      provider: 'openai',
      name: 'minimax-api',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'sk-minimax-key',
      models: ['MiniMax-M2.7'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-minimax-bare';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: customProfile.id,
      defaultModel: 'MiniMax-M2.7',
      provider: 'minimax',
    });

    let seenConfigPath;
    let seenRuntimeConfig;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
        assert.ok(seenConfigPath, 'bare model + ocProviderName should receive OPENCODE_CONFIG');
        seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
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
          prompt: 'test bare model routing',
          userId: 'user-f189-bare-model',
          threadId: 'thread-f189-bare-model',
          isLastCat: true,
        }),
      );
      assert.ok(messages.some((m) => m.type === 'done'));
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE, 'minimax/MiniMax-M2.7');
    assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-minimax-key');
    assert.equal(callbackEnv.CAT_CAFE_OC_BASE_URL, 'https://api.minimax.io/v1');
    assert.equal(seenRuntimeConfig?.model, 'minimax/MiniMax-M2.7');
    assert.equal(seenRuntimeConfig?.provider?.minimax?.npm, '@ai-sdk/openai-compatible');
    assert.ok(seenRuntimeConfig?.provider?.minimax?.models?.['MiniMax-M2.7']);
    await assert.rejects(readFile(seenConfigPath, 'utf-8'));
  });

  it('clowder-ai#223-fix: builtin ocProviderName with custom baseUrl still generates OPENCODE_CONFIG', async () => {
    // Regression: ocProviderName="anthropic" + baseUrl="https://api.minimax.io/v1"
    // was skipped by BUILTIN_OPENCODE_PROVIDERS guard, leaving opencode without custom config.
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f189-builtin-ocprovider-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const customProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'minimax-anthropic-compat',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'sk-minimax-key',
      models: ['MiniMax-M2.7'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-minimax-builtin-oc';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: customProfile.id,
      defaultModel: 'MiniMax-M2.7',
      provider: 'anthropic',
    });

    let seenConfigPath;
    let seenRuntimeConfig;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
        assert.ok(seenConfigPath, 'builtin ocProviderName + custom baseUrl must still receive OPENCODE_CONFIG');
        seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
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
          prompt: 'test builtin provider with custom baseUrl',
          userId: 'user-f189-builtin-fix',
          threadId: 'thread-f189-builtin-fix',
          isLastCat: true,
        }),
      );
      assert.ok(messages.some((m) => m.type === 'done'));
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE, 'anthropic/MiniMax-M2.7');
    assert.ok(callbackEnv.OPENCODE_CONFIG, 'OPENCODE_CONFIG must be set for custom endpoint');
    assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-minimax-key');
    assert.equal(callbackEnv.CAT_CAFE_OC_BASE_URL, 'https://api.minimax.io/v1');
    assert.equal(seenRuntimeConfig?.model, 'anthropic/MiniMax-M2.7');
    assert.ok(seenRuntimeConfig?.provider?.anthropic);
    assert.ok(seenRuntimeConfig?.provider?.anthropic?.models?.['MiniMax-M2.7']);
    await assert.rejects(readFile(seenConfigPath, 'utf-8'));
  });

  it('fix(#280): builtin ocProviderName without baseUrl still generates OPENCODE_CONFIG', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'fix280-builtin-oc-provider-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const anthropicProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'anthropic-api',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'anthropic',
      apiKey: 'sk-ant-test-key',
      models: ['claude-opus-4-6'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-anthropic-builtin-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: anthropicProfile.id,
      defaultModel: 'claude-opus-4-6',
      provider: 'anthropic',
    });

    let seenConfigPath;
    let seenRuntimeConfig;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
        assert.ok(seenConfigPath, 'builtin ocProviderName should still receive OPENCODE_CONFIG');
        seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
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
          prompt: 'test builtin provider routing',
          userId: 'user-fix280',
          threadId: 'thread-fix280',
          isLastCat: true,
        }),
      );
      assert.ok(messages.some((m) => m.type === 'done'));
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE, 'anthropic/claude-opus-4-6');
    assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-ant-test-key');
    assert.equal(seenRuntimeConfig?.model, 'anthropic/claude-opus-4-6');
    assert.equal(seenRuntimeConfig?.provider?.anthropic?.npm, '@ai-sdk/anthropic');
    assert.ok(seenRuntimeConfig?.provider?.anthropic?.models?.['claude-opus-4-6']);
    await assert.rejects(readFile(seenConfigPath, 'utf-8'));
  });

  it('known model with mcpServerPath enters clowder-ai#223 gate for deterministic MCP injection', async () => {
    // When a model IS in the known-models set (so !knownModels.has(model) is false)
    // but resolveDefaultClaudeMcpServerPath() returns a path (mcpServerPath exists),
    // the || mcpServerPath branch should trigger clowder-ai#223 config generation.
    // This ensures known models get deterministic MCP in game sessions.
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    mod._resetOpenCodeKnownModels(new Set(['anthropic/claude-opus-4-6']));
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'mcp-known-model-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    // Create fake mcp-server/dist/index.js so resolveDefaultClaudeMcpServerPath() finds it
    const mcpDir = join(root, 'packages', 'mcp-server', 'dist');
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, 'index.js'), '// stub mcp server', 'utf-8');

    const anthropicProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'claude-api-mcp',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-mcp-key',
      models: ['claude-opus-4-6'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-mcp-known-model-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: anthropicProfile.id,
      defaultModel: 'anthropic/claude-opus-4-6',
      // Deliberately NO provider field — so hasExplicitOcProvider is false.
      // The test verifies the || mcpServerPath branch alone triggers config generation.
    });

    let seenConfigPath;
    let seenRuntimeConfig;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
        assert.ok(seenConfigPath, 'known model must still receive OPENCODE_CONFIG when mcpServerPath exists');
        try {
          seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
        } catch {
          /* will be checked below */
        }
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
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
          prompt: 'test known model with mcp injection',
          userId: 'user-mcp-known-model',
          threadId: 'thread-mcp-known-model',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      mod._resetOpenCodeKnownModels(null);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.ok(callbackEnv.OPENCODE_CONFIG, 'OPENCODE_CONFIG must be set when mcpServerPath exists for known model');
    assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-ant-mcp-key');
    assert.ok(seenRuntimeConfig, 'runtime config must be parseable');
    assert.ok(seenRuntimeConfig.mcp, 'runtime config must contain mcp section');
    const mcpCafe = seenRuntimeConfig.mcp['cat-cafe'];
    assert.equal(mcpCafe.type, 'local');
    assert.equal(mcpCafe.command.length, 2);
    assert.equal(mcpCafe.command[0], 'node');
    assert.ok(
      mcpCafe.command[1].endsWith('/packages/mcp-server/dist/index.js'),
      `mcp command[1] must point to mcp-server entry: ${mcpCafe.command[1]}`,
    );
    // Config file should be cleaned up after invocation
    await assert.rejects(readFile(seenConfigPath, 'utf-8'));
  });

  it(
    'known model with CAT_CAFE_MCP_SERVER_PATH enters clowder-ai#223 gate without default candidates',
    { concurrency: false },
    async () => {
      const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
      mod._resetOpenCodeKnownModels(new Set(['anthropic/claude-opus-4-6']));
      const { createProviderProfile } = await import('./helpers/create-test-account.js');
      const root = await mkdtemp(join(tmpdir(), 'mcp-env-known-model-'));
      const apiDir = join(root, 'packages', 'api');
      const externalMcpDir = join(root, 'tmp-mcp');
      await mkdir(apiDir, { recursive: true });
      await mkdir(externalMcpDir, { recursive: true });
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
      const envMcpPath = join(externalMcpDir, 'index.js');
      await writeFile(envMcpPath, '// stub mcp server from env', 'utf-8');

      const anthropicProfile = await createProviderProfile(root, {
        provider: 'anthropic',
        name: 'claude-api-mcp-env',
        mode: 'api_key',
        authType: 'api_key',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-mcp-env-key',
        models: ['claude-opus-4-6'],
        setActive: false,
      });

      const registrySnapshot = catRegistry.getAllConfigs();
      const originalConfig = catRegistry.tryGet('opencode')?.config;
      assert.ok(originalConfig, 'opencode config should exist in registry');
      const boundCatId = 'opencode-mcp-env-known-model-test';
      catRegistry.register(boundCatId, {
        ...originalConfig,
        id: boundCatId,
        mentionPatterns: [`@${boundCatId}`],
        clientId: 'opencode',
        accountRef: anthropicProfile.id,
        defaultModel: 'anthropic/claude-opus-4-6',
      });

      let seenConfigPath;
      let seenRuntimeConfig;
      const optionsSeen = [];
      const service = {
        async *invoke(_prompt, options) {
          optionsSeen.push(options ?? {});
          seenConfigPath = options?.callbackEnv?.OPENCODE_CONFIG;
          assert.ok(
            seenConfigPath,
            'known model must still receive OPENCODE_CONFIG when CAT_CAFE_MCP_SERVER_PATH is set',
          );
          try {
            seenRuntimeConfig = JSON.parse(await readFile(seenConfigPath, 'utf-8'));
          } catch {
            /* checked below */
          }
          yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
        },
      };

      const deps = makeDeps();
      const previousCwd = process.cwd();
      const previousEnvMcpPath = process.env.CAT_CAFE_MCP_SERVER_PATH;
      try {
        process.chdir(apiDir);
        process.env.CAT_CAFE_MCP_SERVER_PATH = envMcpPath;
        await collect(
          invokeSingleCat(deps, {
            catId: boundCatId,
            service,
            prompt: 'test known model with env mcp injection',
            userId: 'user-mcp-env-known-model',
            threadId: 'thread-mcp-env-known-model',
            isLastCat: true,
          }),
        );
      } finally {
        process.chdir(previousCwd);
        if (previousEnvMcpPath === undefined) delete process.env.CAT_CAFE_MCP_SERVER_PATH;
        else process.env.CAT_CAFE_MCP_SERVER_PATH = previousEnvMcpPath;
        mod._resetOpenCodeKnownModels(null);
        catRegistry.reset();
        for (const [id, config] of Object.entries(registrySnapshot)) {
          catRegistry.register(id, config);
        }
        await rmWithRetry(root);
      }

      const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
      assert.ok(
        callbackEnv.OPENCODE_CONFIG,
        'OPENCODE_CONFIG must be set when CAT_CAFE_MCP_SERVER_PATH exists for known model',
      );
      assert.equal(callbackEnv.CAT_CAFE_OC_API_KEY, 'sk-ant-mcp-env-key');
      assert.ok(seenRuntimeConfig, 'runtime config must be parseable');
      assert.ok(seenRuntimeConfig.mcp, 'runtime config must contain mcp section');
      const mcpCafe = seenRuntimeConfig.mcp['cat-cafe'];
      assert.equal(mcpCafe.type, 'local');
      assert.equal(mcpCafe.command[0], 'node');
      assert.equal(mcpCafe.command[1], envMcpPath);
      await assert.rejects(readFile(seenConfigPath, 'utf-8'));
    },
  );

  it('fix(#280): known legacy model without provider skips runtime config', async () => {
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    mod._resetOpenCodeKnownModels(new Set(['anthropic/claude-opus-4-6']));
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'fix280-known-legacy-model-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const anthropicProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'claude-api-known',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-known-key',
      models: ['claude-opus-4-6'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-known-legacy-model-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: anthropicProfile.id,
      defaultModel: 'anthropic/claude-opus-4-6',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        assert.equal(options?.callbackEnv?.OPENCODE_CONFIG, undefined);
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    const deps = makeDeps();
    const previousCwd = process.cwd();
    const previousEnvMcpPath = process.env.CAT_CAFE_MCP_SERVER_PATH;
    try {
      process.chdir(apiDir);
      delete process.env.CAT_CAFE_MCP_SERVER_PATH;
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test known legacy model skip',
          userId: 'user-fix280-known-legacy',
          threadId: 'thread-fix280-known-legacy',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnvMcpPath === undefined) delete process.env.CAT_CAFE_MCP_SERVER_PATH;
      else process.env.CAT_CAFE_MCP_SERVER_PATH = previousEnvMcpPath;
      mod._resetOpenCodeKnownModels(null);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.OPENCODE_CONFIG, undefined);
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE, undefined);
  });

  it('clowder-ai#223-P1: provider takes priority over parseOpenCodeModel for namespaced models', async () => {
    // Regression (砚砚 review): defaultModel="z-ai/glm-4.7" + provider="openrouter"
    // parseOpenCodeModel parses "z-ai" as providerName, but the real provider is "openrouter".
    // provider must take priority when set — the "/" in the model is a namespace separator.
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f189-namespace-priority-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const orProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'openrouter-profile',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'sk-or-key',
      models: ['z-ai/glm-4.7'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig, 'opencode config should exist in registry');
    const boundCatId = 'opencode-or-namespace';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: orProfile.id,
      defaultModel: 'z-ai/glm-4.7',
      provider: 'openrouter',
    });

    let seenRuntimeConfig;
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        const configPath = options?.callbackEnv?.OPENCODE_CONFIG;
        if (configPath) {
          seenRuntimeConfig = JSON.parse(await readFile(configPath, 'utf-8'));
        }
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
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
          prompt: 'test namespace model priority',
          userId: 'user-f189-ns',
          threadId: 'thread-f189-ns',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    // Key assertions: provider "openrouter" must win over parsed "z-ai"
    assert.equal(
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
      'openrouter/z-ai/glm-4.7',
      'effective model must use provider as provider prefix, not parsed z-ai',
    );
    assert.ok(callbackEnv.OPENCODE_CONFIG, 'OPENCODE_CONFIG must be set');
    assert.equal(seenRuntimeConfig?.model, 'openrouter/z-ai/glm-4.7');
    assert.ok(seenRuntimeConfig?.provider?.openrouter, 'runtime config provider must be openrouter, not z-ai');
  });

  it('clowder-ai#223-P1-2: same-provider prefix in defaultModel + provider must NOT double-prefix', async () => {
    // Regression (砚砚 review R2): defaultModel="openai/gpt-5.4" + provider="openai"
    // Must produce effectiveModel="openai/gpt-5.4", NOT "openai/openai/gpt-5.4".
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f189-double-prefix-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    const oaiProfile = await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'openai-compat',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-key',
      models: ['gpt-5.4'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig);
    const boundCatId = 'opencode-double-prefix-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: oaiProfile.id,
      defaultModel: 'openai/gpt-5.4',
      provider: 'openai',
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
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test double prefix',
          userId: 'user-f189-dp',
          threadId: 'thread-f189-dp',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(root);
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    // With safeProviderName remapping, 'openai' → 'openai-compat', so the
    // model override becomes 'openai-compat/gpt-5.4' (no double-prefix).
    assert.equal(
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
      'openai-compat/gpt-5.4',
      'must remap openai → openai-compat and NOT double-prefix',
    );
  });

  it('F062-fix: skips auto-seal for api_key mode when context health is approx', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const root = await mkdtemp(join(tmpdir(), 'f062-approx-no-seal-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    // clowder-ai#340: Use well-known ID 'claude' so resolveForClient('anthropic') discovers it.
    await createProviderProfile(root, {
      provider: 'anthropic',
      name: 'claude',
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
      restoreGlobalRoot();
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      await rmWithRetry(root);
    }
  });

  it('F062-fix: skips auto-seal for api_key + compress strategy even when context health is exact', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
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
    setGlobalRoot(root);
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
      restoreGlobalRoot();
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      _clearTestStrategyOverrides();
      await rmWithRetry(root);
    }
  });

  it('F062-fix: keeps auto-seal for api_key + handoff strategy on exact budget overflow', async () => {
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
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
    setGlobalRoot(root);
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
      restoreGlobalRoot();
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      _clearTestStrategyOverrides();
      await rmWithRetry(root);
    }
  });

  it('F101: game thread projectPath (games/*) does not trigger governance gate', async () => {
    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = {
      ...makeDeps(),
      threadStore: {
        get: async () => ({ projectPath: 'games/werewolf', createdBy: 'user1' }),
        updateParticipantActivity: async () => {},
      },
    };

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'opus',
        service,
        prompt: 'test game briefing',
        userId: 'user1',
        threadId: 'thread-game-werewolf',
        isLastCat: true,
      }),
    );

    assert.ok(
      !msgs.some((m) => m.type === 'system_info' && m.content?.includes('governance_blocked')),
      'game thread must NOT trigger governance_blocked',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should reach done (service was invoked)',
    );
    assert.equal(optionsSeen[0]?.workingDirectory, undefined, 'workingDirectory must be undefined for game threads');
  });

  it('bug-fix: account resolution uses runtime root (process.cwd()), not thread.projectPath', async () => {
    // Regression: thread.projectPath points to dev worktree which lacks runtime-only accounts.
    // Account resolution must always use process.cwd() (the runtime root).
    const { createProviderProfile } = await import('./helpers/create-test-account.js');

    // runtimeRoot = where the API process runs (has the custom account)
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'account-runtime-root-'));
    const runtimeApiDir = join(runtimeRoot, 'packages', 'api');
    await mkdir(runtimeApiDir, { recursive: true });
    await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');

    // devRoot = where thread.projectPath points (missing the custom account)
    const devRoot = await mkdtemp(join(tmpdir(), 'account-dev-root-'));
    const devApiDir = join(devRoot, 'packages', 'api');
    await mkdir(devApiDir, { recursive: true });
    await writeFile(join(devRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    // Write a minimal catalog in devRoot WITHOUT the custom account
    const devCatCafe = join(devRoot, '.cat-cafe');
    await mkdir(devCatCafe, { recursive: true });
    await writeFile(join(devCatCafe, 'cat-catalog.json'), JSON.stringify({ accounts: {} }), 'utf-8');

    // Create the custom account only in runtimeRoot
    const customProfile = await createProviderProfile(runtimeRoot, {
      provider: 'openai',
      name: 'custom-runtime-only',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'sk-custom-key',
      models: ['custom-model'],
      setActive: false,
    });

    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opencode')?.config;
    assert.ok(originalConfig);
    const boundCatId = 'opencode-divergent-path-test';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      clientId: 'opencode',
      accountRef: customProfile.id,
      defaultModel: 'custom-model',
      provider: 'custom',
    });

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opencode', timestamp: Date.now() };
      },
    };

    // threadStore returns devRoot as projectPath — simulates Hub-created thread
    const deps = {
      ...makeDeps(),
      threadStore: {
        get: async () => ({ projectPath: devRoot, createdBy: 'user1' }),
        updateParticipantActivity: async () => {},
      },
    };

    const previousCwd = process.cwd();
    try {
      // process.cwd() = runtimeRoot (where the custom account exists)
      process.chdir(runtimeApiDir);
      const msgs = await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test divergent projectPath account resolution',
          userId: 'user-divergent',
          threadId: 'thread-divergent',
          isLastCat: true,
        }),
      );
      // Must reach done — account resolution should succeed via process.cwd().
      // If it used thread.projectPath (devRoot), it would throw "bound account not found".
      assert.ok(
        msgs.some((m) => m.type === 'done'),
        'invocation must succeed despite divergent thread.projectPath',
      );
      assert.ok(
        !msgs.some((m) => m.type === 'error' && m.error?.includes('bound account')),
        'must NOT fail with "bound account not found"',
      );
    } finally {
      process.chdir(previousCwd);
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rmWithRetry(runtimeRoot);
      await rmWithRetry(devRoot);
    }
  });
});

// F155: Old pre-invocation guide routing hook tests removed.
// Guide matching now happens at routing layer (route-serial/route-parallel)
// and is injected via SystemPromptBuilder + guide-interaction skill.
// New tests for the routing-layer matching should be added separately.
