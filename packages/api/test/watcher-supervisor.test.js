import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { watcherRawWindow } from '../dist/domains/concierge/watcher/watcher-prompt.js';

async function setup(run, overrides = {}) {
  const configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig('owner', 0, { scope: 'all', memberCatId: 'codex' });
  const executions = new InMemoryTurnExecutionStore();
  const sessions = new SessionChainStore();
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  const errors = [];
  const messages = new MessageStore();
  const supervisor = new WatcherSupervisor({
    userId: 'owner',
    configs,
    executions,
    sessions,
    threads,
    messages,
    labels: {
      async list() {
        return [];
      },
    },
    capability: () => ({ supported: true }),
    service: () => ({}),
    run,
    report: (error) => errors.push(error),
    ...overrides,
  });
  await supervisor.start();
  return { configs, executions, sessions, threads, thread, supervisor, errors, messages };
}
function work(f, id, kind = 'ordinary') {
  f.executions.createRunning({
    invocationId: id,
    parentInvocationId: `parent-${id}`,
    userId: 'owner',
    threadId: f.thread.id,
    catId: 'codex',
    executionKind: kind,
    outputFence: 'open',
    providerLifecycleTracked: true,
    startedAt: 100,
  });
  f.executions.markProviderStarted(id, 100);
}
function settle(f, id) {
  f.executions.recordProviderTeardown(id, 210);
  f.executions.transitionTerminal(id, { status: 'succeeded', endedAt: 220 });
  f.executions.markResponseSettled(id, { kind: 'no_response', reason: 'tool_only', settledAt: 230 });
}
async function flush() {
  for (let index = 0; index < 12; index++) await setImmediate();
}

for (const boundary of ['preferences', 'capability', 'session', 'thread']) {
  test(`a transient ${boundary} failure before run retries the same settled source without another work ending`, async () => {
    const seen = [];
    let capabilityFails = boundary === 'capability';
    const f = await setup(
      async (owners, { source, session }) => {
        seen.push(source.invocationId);
        const state = parseWatcherSessionState((await owners.sessions.get(session.id)).watcherState);
        await owners.sessions.compareAndSetWatcherState(session.id, state.revision, {
          ...state,
          revision: state.revision + 1,
          afterSequence: source.settledSequence,
        });
      },
      {
        capability: () => {
          if (capabilityFails) {
            capabilityFails = false;
            throw new Error('transient capability');
          }
          return { supported: true };
        },
      },
    );
    const owner = boundary === 'preferences' ? f.configs : boundary === 'session' ? f.sessions : f.threads;
    const method =
      boundary === 'preferences' ? 'readWatcherConfig' : boundary === 'session' ? 'getOrCreateActive' : 'get';
    if (boundary !== 'capability') {
      const original = owner[method].bind(owner);
      let fail = true;
      owner[method] = (...args) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error(`transient ${boundary}`));
        }
        return original(...args);
      };
    }
    try {
      work(f, 'only-source');
      settle(f, 'only-source');
      for (let round = 0; round < 4; round++) {
        await f.supervisor.poll();
        await flush();
      }
      assert.equal(f.errors.length, 1);
      assert.deepEqual(seen, ['only-source']);
    } finally {
      await f.supervisor.stop();
    }
  });
}

test('one failed source has a durable result and cannot strand the next settled source', async () => {
  const seen = [];
  const f = await setup(async (owners, { source, session }) => {
    seen.push(source.invocationId);
    if (source.invocationId === 'work-1') throw new Error('persistent first-source failure');
    const state = parseWatcherSessionState((await owners.sessions.get(session.id)).watcherState);
    await owners.sessions.compareAndSetWatcherState(session.id, state.revision, {
      ...state,
      revision: state.revision + 1,
      afterSequence: source.settledSequence,
    });
  });
  try {
    for (const id of ['work-1', 'work-2']) {
      work(f, id);
      settle(f, id);
    }
    await f.supervisor.poll();
    await flush();
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, ['work-1', 'work-2']);
    const failures = await f.executions.listByParent('watcher-source:codex:work-1');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 'failed');
    assert.equal(failures[0].causal.watcherSourceInvocationId, 'work-1');
  } finally {
    await f.supervisor.stop();
  }
});

for (const scope of ['global', 'thread']) {
  for (const settlesWhileOff of [true, false]) {
    test(`${scope} reactivation excludes the disabled raw interval even when the settlement floor is unchanged (${settlesWhileOff ? 'with' : 'without'} offline work)`, async (t) => {
      let now = 100;
      t.mock.method(Date, 'now', () => now);
      const seen = [];
      const f = await setup(async (owners, { source, session }) => {
        const state = parseWatcherSessionState((await owners.sessions.get(session.id)).watcherState);
        const window = await watcherRawWindow(owners.messages, 'owner', source.threadId, state, undefined, 230);
        seen.push({ body: window.body, notes: state.notes });
        await owners.sessions.compareAndSetWatcherState(session.id, state.revision, {
          ...state,
          revision: state.revision + 1,
          notes: 'kept-note',
          afterSequence: source.settledSequence,
          consumedThrough: window.frontier,
          messageOffset: window.offset,
        });
      });
      const original = (content, timestamp) =>
        f.messages.append({
          userId: 'owner',
          threadId: f.thread.id,
          from: { kind: 'user', userId: 'owner' },
          content,
          timestamp,
          mentions: [],
        });
      try {
        await original('BEFORE_CLOSE', 10);
        work(f, 'before');
        settle(f, 'before');
        await f.supervisor.poll();
        await flush();
        assert.equal(seen.length, 1);
        now = 140;
        if (scope === 'global') {
          const config = await f.configs.readWatcherConfig('owner');
          await f.configs.updateWatcherConfig('owner', config.revision, { enabled: false });
        } else await f.threads.updateWatcherControl(f.thread.id, 0, { enabled: false });
        await original('EXCLUDED_WHILE_OFF', 150);
        if (settlesWhileOff) {
          work(f, 'offline');
          settle(f, 'offline');
          await f.supervisor.poll();
          await flush();
        }
        assert.equal(seen.length, 1);
        now = 170;
        const floor = await f.executions.settledHead('owner', f.thread.id);
        if (scope === 'global') {
          const config = await f.configs.readWatcherConfig('owner');
          await f.configs.updateWatcherConfig('owner', config.revision, { enabled: true }, floor);
        } else {
          const thread = await f.threads.get(f.thread.id);
          await f.threads.updateWatcherControl(
            f.thread.id,
            thread.watcher.revision,
            { enabled: true },
            { startedAfterSequence: floor },
          );
        }
        now = 180;
        await original('VISIBLE_AFTER_REOPEN', 180);
        work(f, 'after');
        settle(f, 'after');
        await f.supervisor.poll();
        await flush();
        assert.equal(seen.length, 2);
        assert.equal(seen[1].body.includes('EXCLUDED_WHILE_OFF'), false);
        assert.ok(seen[1].body.includes('VISIBLE_AFTER_REOPEN'));
        assert.equal(seen[1].notes, 'kept-note');
        assert.deepEqual(f.errors, []);
      } finally {
        await f.supervisor.stop();
      }
    });
  }
}

test('only settled work endings wake the watcher, including when both roles share the same catId', async () => {
  const seen = [];
  const f = await setup(async (owners, { source, session }) => {
    seen.push(source.invocationId);
    const state = parseWatcherSessionState((await owners.sessions.get(session.id)).watcherState);
    await owners.sessions.compareAndSetWatcherState(session.id, state.revision, {
      ...state,
      revision: state.revision + 1,
      afterSequence: source.settledSequence,
    });
  });
  try {
    work(f, 'work-1');
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, [], 'a stop receipt without provider teardown and response settlement cannot trigger');
    settle(f, 'work-1');
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, ['work-1']);
    work(f, 'watcher-self', 'watcher');
    settle(f, 'watcher-self');
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, ['work-1']);
    work(f, 'guard-only', 'routing_guard');
    settle(f, 'guard-only');
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, ['work-1'], 'an auxiliary routing guard is not a finished working invocation');
    work(f, 'work-2');
    settle(f, 'work-2');
    await f.supervisor.poll();
    await flush();
    assert.deepEqual(seen, ['work-1', 'work-2']);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.supervisor.stop();
  }
});

test('a watcher that never finishes cannot delay the work commit or its next turn', async () => {
  let release;
  const f = await setup(
    async (_owners, { signal }) =>
      new Promise((resolve) => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      }),
  );
  try {
    work(f, 'work-before-hang');
    settle(f, 'work-before-hang');
    await f.supervisor.poll();
    await flush();
    assert.equal(typeof release, 'function');
    work(f, 'next-work');
    settle(f, 'next-work');
    assert.equal(f.executions.get('next-work').status, 'succeeded');
    assert.equal(f.executions.listSettled({ userId: 'owner', threadId: f.thread.id }).records.length, 2);
  } finally {
    await f.supervisor.stop();
  }
});
