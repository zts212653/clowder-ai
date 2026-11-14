import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';

const NOW = Date.UTC(2026, 10, 8, 3, 33);
const OLD = NOW - 3 * 24 * 60 * 60 * 1000;
const THREAD = 'truthful-navigation';

function setup() {
  const messageStore = new MessageStore();
  const deps = {
    messageStore,
    deliveryCursorStore: new DeliveryCursorStore(),
    invocationDeps: {
      threadStore: {
        get: async () => ({ id: THREAD, userId: 'owner', title: 'Anthropic IPO' }),
        getThreadMemory: async () => null,
        getThreadWork: async () => null,
      },
    },
  };
  const append = (from, content, extra = {}) =>
    messageStore.append({ userId: 'owner', threadId: THREAD, from, content, mentions: [], timestamp: NOW, ...extra });
  return { deps, append };
}

function options(contextMode, routeTopology) {
  return {
    effectiveMaxContextTokens: 50000,
    nowMs: NOW,
    threadTitle: 'Anthropic IPO',
    contextProjection: {
      coordinate: {
        providerCarrier: { provider: 'codex', carrier: 'exec_json' },
        invocationOrigin: 'interactive',
        routeTopology,
      },
      contextEpoch: 1,
      contextMode,
      transition: 'scope_first_seen',
      reason: 'no_prior_session',
    },
  };
}

// Real incremental assembly, with no provider, network, Redis or timers.
for (const mode of ['cold', 'hot']) {
  for (const topology of ['serial', 'parallel']) {
    test(`${mode}/${topology}: complete ordinary input does not inherit old work or prose @`, async () => {
      const { deps, append } = setup();
      const old = append({ kind: 'agent', catId: 'codex' }, 'Example: ```\n@opus\n```', { timestamp: OLD });
      append({ kind: 'agent', catId: 'opus' }, 'My own Identity: @opus');
      const current = append({ kind: 'user', userId: 'owner' }, '今天吃了什么呀');
      const result = await assembleIncrementalContext(
        deps,
        'owner',
        THREAD,
        'opus',
        current.id,
        'play',
        options(mode, topology),
      );
      assert.ok(result.contextText.includes(current.content));
      assert.doesNotMatch(
        result.navigationHeader,
        /传球|最近发言|本线标题|近期工作线|真相源: 未定位|下一步:|cat_cafe_get_thread_context/,
      );
      assert.ok(!result.navigationHeader.includes(old.id));
      assert.match(result.navigationHeader, /本轮输入来源/);
      assert.ok(result.navigationHeader.includes(current.id));
    });

    test(`${mode}/${topology}: delayed same-cat cross-thread trigger retains exact provenance`, async () => {
      const { deps, append } = setup();
      const source = append({ kind: 'agent', catId: 'opus' }, '这个结果从另一条线回来', {
        timestamp: OLD,
        extra: { crossPost: { sourceThreadId: 'original-owner-thread' } },
      });
      const result = await assembleIncrementalContext(
        deps,
        'owner',
        THREAD,
        'opus',
        source.id,
        'play',
        options(mode, topology),
      );
      assert.ok(result.contextText.includes(source.content));
      assert.match(result.navigationHeader, /本轮输入来源/);
      assert.ok(result.navigationHeader.includes(source.id));
      assert.ok(result.navigationHeader.includes('original-owner-thread'));
      assert.match(result.navigationHeader, /2026-11-0[45]/, 'stored source time survives queue delay');
      assert.doesNotMatch(result.navigationHeader, /传球|之前说过|以传球为准/);
    });
  }

  test(`${mode}: history without a current trigger never invents an invocation source`, async () => {
    const { deps, append } = setup();
    append({ kind: 'agent', catId: 'codex' }, '@opus 已处理的旧交接', { timestamp: OLD, mentions: ['opus'] });
    const result = await assembleIncrementalContext(
      deps,
      'owner',
      THREAD,
      'opus',
      undefined,
      'play',
      options(mode, 'serial'),
    );
    assert.doesNotMatch(result.navigationHeader, /本轮输入来源|传球|已处理的旧交接/);
  });

  test(`${mode}: source metadata obeys tenant, thread, deletion and whisper visibility`, async () => {
    for (const changes of [
      { visibility: 'whisper', whisperTo: ['gemini'] },
      { userId: 'another-owner' },
      { threadId: 'another-thread' },
      { from: { kind: 'user', userId: 'owner' }, deliveryStatus: 'queued' },
      { deletedAt: NOW },
      { _tombstone: true },
    ]) {
      const { deps, append } = setup();
      const hidden = append({ kind: 'agent', catId: 'codex' }, 'PRIVATE_TRIGGER', changes);
      const result = await assembleIncrementalContext(
        deps,
        'owner',
        THREAD,
        'opus',
        hidden.id,
        'play',
        options(mode, 'serial'),
      );
      assert.doesNotMatch(result.navigationHeader, /本轮输入来源|PRIVATE_TRIGGER/);
      assert.ok(!result.navigationHeader.includes(hidden.id));
    }
  });

  test(`${mode}: a truncated source provides an exact optional read, cold alone does not`, async () => {
    const { deps, append } = setup();
    const source = append({ kind: 'user', userId: 'owner' }, '这段原文'.repeat(26000));
    const result = await assembleIncrementalContext(deps, 'owner', THREAD, 'opus', source.id, 'play', {
      ...options(mode, 'serial'),
      effectiveMaxContextTokens: 500000,
    });
    assert.ok(result.contextText.includes('truncated'));
    const pointer = result.contextText.split('\n').find((line) => line.includes('cat_cafe_get_thread_context')) ?? '';
    assert.ok(pointer.includes(`messageId: "${source.id}"`));
    assert.match(pointer, /responseMode: "full"/);
  });
}

test('ordinary new input preserves independently owned Task, wait and lifecycle situation', async () => {
  const { deps, append } = setup();
  const taskStore = new TaskStore();
  const task = taskStore.create({
    title: '仍在等待的既有任务',
    threadId: THREAD,
    ownerCatId: 'opus',
    createdBy: 'owner',
    userId: 'owner',
  });
  deps.taskStore = taskStore;
  deps.ownedWaitStatusReader = async () => true;
  deps.threadExecutionSituationSource = {
    resolve: async () => ({ kind: 'thread_execution_situation.v1', complete: true, activeRuns: [] }),
  };
  const current = append({ kind: 'user', userId: 'owner' }, '先陪我聊两句');
  const result = await assembleIncrementalContext(
    deps,
    'owner',
    THREAD,
    'opus',
    current.id,
    'play',
    options('cold', 'serial'),
  );
  assert.ok(result.navigationHeader.includes(task.title));
  assert.match(result.navigationHeader, /成员运行态: 当前无其他成员执行/);
  assert.doesNotMatch(result.navigationHeader, /未挂等待/);
  assert.equal(taskStore.get(task.id).status, task.status);
});

test('F337: navigation shows how teammates in this thread last stopped, for the thread owner', async () => {
  const { deps, append } = setup();
  const seen = [];
  deps.threadExecutionSituationSource = {
    resolve: async (threadId, userId) => {
      seen.push([threadId, userId]);
      return {
        kind: 'thread_execution_situation.v1',
        complete: true,
        activeRuns: [],
        recentStops: [
          { catId: 'kimi31-pro', status: 'failed', terminalReason: 'host_sleep', endedAt: NOW - 60_000 },
          { catId: 'opus', status: 'canceled', terminalReason: 'user_cancel', endedAt: NOW - 30_000 },
        ],
      };
    },
  };
  const current = append({ kind: 'user', userId: 'owner' }, '别找墨墨了');
  const result = await assembleIncrementalContext(
    deps,
    'owner',
    THREAD,
    'opus',
    current.id,
    'play',
    options('cold', 'serial'),
  );
  assert.deepEqual(seen, [[THREAD, 'owner']]);
  assert.match(result.navigationHeader, /最近停下的成员/);
  assert.match(result.navigationHeader, /\(kimi31-pro\) · .* · 电脑睡眠打断，开盖后会自动接着做/);
  assert.doesNotMatch(result.navigationHeader, /\(opus\) · /, 'the reader’s own ending is not a teammate stop');
});

test('F337: a stop read cut by its page says so instead of presenting the window as complete', async () => {
  const { deps, append } = setup();
  deps.threadExecutionSituationSource = {
    resolve: async () => ({
      kind: 'thread_execution_situation.v1',
      complete: true,
      activeRuns: [],
      recentStops: [],
      recentStopsComplete: false,
    }),
  };
  const current = append({ kind: 'user', userId: 'owner' }, '谁停了？');
  const result = await assembleIncrementalContext(
    deps,
    'owner',
    THREAD,
    'opus',
    current.id,
    'play',
    options('cold', 'serial'),
  );
  assert.match(result.navigationHeader, /最近停下的成员:\n  （本线程最近结束的轮次很多，只核对了最新的一页/);
});

test('a pending wake is input provenance only after its full body survives the actual projection', async () => {
  const { deps, append } = setup();
  const pending = append({ kind: 'agent', catId: 'codex' }, 'x'.repeat(120000));
  const current = append({ kind: 'user', userId: 'owner' }, '现在的输入');
  const result = await assembleIncrementalContext(deps, 'owner', THREAD, 'opus', current.id, 'play', {
    ...options('cold', 'serial'),
    effectiveMaxContextTokens: 2000,
    resolvePendingWakeMessageIds: async () => [pending.id],
  });
  assert.ok(!result.exposedMessageIds.includes(pending.id));
  assert.ok(!result.navigationHeader.includes(pending.id));
  assert.ok(result.navigationHeader.includes(current.id));
});
