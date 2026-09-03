import assert from 'node:assert/strict';
import { test } from 'node:test';

const controlModule = import('../dist/domains/cats/services/agents/providers/CodexAppServerSessionControl.js');

class Inbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function rejectAfter(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('test_guard_timeout')), ms);
    timer.unref?.();
  });
}

test('native session control returns only a provider-minted compaction observation', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  const writes = [];
  const wire = {
    read: () => inbox,
    write: async (message) => {
      writes.push(message);
      if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        inbox.push({ id: message.id, result: { thread: { id: 'native-thread-1' } } });
      }
      if (message.method === 'thread/compact/start') {
        inbox.push({ id: message.id, result: {} });
        inbox.push({
          method: 'item/started',
          params: {
            threadId: 'native-thread-1',
            turnId: 'compact-turn-1',
            item: { id: 'compact-item-1', type: 'contextCompaction' },
          },
        });
        inbox.push({
          method: 'turn/completed',
          params: {
            threadId: 'native-thread-1',
            turn: { id: 'compact-turn-1', status: 'completed' },
          },
        });
      }
    },
    close: async () => inbox.close(),
    terminate: async () => inbox.close(),
  };

  const observation = await requestCodexAppServerCompaction({
    wire,
    threadId: 'native-thread-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(observation, {
    eventId: 'context-compaction:codex:app_server:native-thread-1:compact-turn-1:compact-item-1',
    runtimeSessionId: 'native-thread-1',
    evidenceRef: 'codex_app_server_context_compaction:native-thread-1:compact-turn-1:compact-item-1',
  });
  assert.deepEqual(
    writes.filter((message) => typeof message.method === 'string').map((message) => message.method),
    ['initialize', 'initialized', 'thread/resume', 'thread/compact/start'],
  );
});

test('native session control does not expose ready before the provider compact turn settles', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  let compactTurnStarted;
  const compactTurnStartedPromise = new Promise((resolve) => {
    compactTurnStarted = resolve;
  });
  const wire = {
    read: () => inbox,
    write: async (message) => {
      if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        inbox.push({ id: message.id, result: { thread: { id: 'native-thread-1' } } });
      }
      if (message.method === 'thread/compact/start') {
        inbox.push({ id: message.id, result: {} });
        inbox.push({
          method: 'item/started',
          params: {
            threadId: 'native-thread-1',
            turnId: 'compact-turn-1',
            item: { id: 'compact-item-1', type: 'contextCompaction' },
          },
        });
        compactTurnStarted();
      }
    },
    close: async () => inbox.close(),
    terminate: async () => inbox.close(),
  };

  let settled = false;
  const pending = requestCodexAppServerCompaction({
    wire,
    threadId: 'native-thread-1',
    timeoutMs: 1_000,
  }).then((value) => {
    settled = true;
    return value;
  });
  await compactTurnStartedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'item observation alone must not expose a ready-to-send boundary');

  inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread-1',
      turn: { id: 'compact-turn-1', status: 'completed' },
    },
  });
  assert.deepEqual(await pending, {
    eventId: 'context-compaction:codex:app_server:native-thread-1:compact-turn-1:compact-item-1',
    runtimeSessionId: 'native-thread-1',
    evidenceRef: 'codex_app_server_context_compaction:native-thread-1:compact-turn-1:compact-item-1',
  });
});

test('native session control ignores other turns and rejects a failed provider compact turn', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  let compactTurnStarted;
  const compactTurnStartedPromise = new Promise((resolve) => {
    compactTurnStarted = resolve;
  });
  const wire = {
    read: () => inbox,
    write: async (message) => {
      if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        inbox.push({ id: message.id, result: { thread: { id: 'native-thread-1' } } });
      }
      if (message.method === 'thread/compact/start') {
        inbox.push({ id: message.id, result: {} });
        inbox.push({
          method: 'item/started',
          params: {
            threadId: 'native-thread-1',
            turnId: 'compact-turn-1',
            item: { id: 'compact-item-1', type: 'contextCompaction' },
          },
        });
        compactTurnStarted();
      }
    },
    close: async () => inbox.close(),
    terminate: async () => inbox.close(),
  };

  let settled = false;
  const pending = requestCodexAppServerCompaction({
    wire,
    threadId: 'native-thread-1',
    timeoutMs: 1_000,
  }).finally(() => {
    settled = true;
  });
  await compactTurnStartedPromise;
  inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread-1',
      turn: { id: 'other-turn', status: 'completed' },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'another provider turn must not settle the compact request');

  inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread-1',
      turn: { id: 'compact-turn-1', status: 'failed' },
    },
  });
  await assert.rejects(pending, /authoritative_compaction_turn_failed:failed/);
});

test('native session control refuses to compact when rejoin returns a different runtime', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  const methods = [];
  const wire = {
    read: () => inbox,
    write: async (message) => {
      if (typeof message.method === 'string') methods.push(message.method);
      if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        inbox.push({ id: message.id, result: { thread: { id: 'other-thread' } } });
      }
    },
    close: async () => inbox.close(),
    terminate: async () => inbox.close(),
  };

  await assert.rejects(
    requestCodexAppServerCompaction({ wire, threadId: 'native-thread-1', timeoutMs: 100 }),
    /authoritative_compaction_rejoin_mismatch/,
  );
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/resume']);
});

test('native session control rejects a compaction minted for another runtime', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  const wire = {
    read: () => inbox,
    write: async (message) => {
      if (message.method === 'initialize') inbox.push({ id: message.id, result: {} });
      if (message.method === 'thread/resume') {
        inbox.push({ id: message.id, result: { thread: { id: 'native-thread-1' } } });
      }
      if (message.method === 'thread/compact/start') {
        inbox.push({ id: message.id, result: {} });
        inbox.push({
          method: 'item/started',
          params: {
            threadId: 'other-thread',
            turnId: 'compact-turn-1',
            item: { id: 'compact-item-1', type: 'contextCompaction' },
          },
        });
      }
    },
    close: async () => inbox.close(),
    terminate: async () => inbox.close(),
  };

  await assert.rejects(
    requestCodexAppServerCompaction({ wire, threadId: 'native-thread-1', timeoutMs: 20 }),
    /authoritative_compaction_observation_timeout/,
  );
});

test('native session control settles and releases the wire when the provider stream closes during initialize', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  inbox.close();
  let closeCalls = 0;
  const wire = {
    read: () => inbox,
    write: async () => {},
    close: async () => {
      closeCalls += 1;
    },
    terminate: async () => {},
  };

  await assert.rejects(
    Promise.race([
      requestCodexAppServerCompaction({ wire, threadId: 'native-thread-1', timeoutMs: 40 }),
      rejectAfter(200),
    ]),
    /authoritative_compaction_stream_closed/,
  );
  assert.equal(closeCalls, 1);
});

test('native session control deadline covers an initialize request that never answers', async () => {
  const { requestCodexAppServerCompaction } = await controlModule;
  const inbox = new Inbox();
  let closeCalls = 0;
  const wire = {
    read: () => inbox,
    write: async () => {},
    close: async () => {
      closeCalls += 1;
      inbox.close();
    },
    terminate: async () => inbox.close(),
  };

  await assert.rejects(
    Promise.race([
      requestCodexAppServerCompaction({ wire, threadId: 'native-thread-1', timeoutMs: 40 }),
      rejectAfter(200),
    ]),
    /authoritative_compaction_observation_timeout/,
  );
  assert.equal(closeCalls, 1);
});

test('native session control options retain only the most-recent 256 sessions per pool', async () => {
  const { rememberCodexAppServerControlOptions, resolveCodexAppServerControlOptions } = await import(
    '../dist/domains/cats/services/agents/providers/codex-app-server-control-options.js'
  );
  const pool = {};
  const options = { command: 'codex', args: ['app-server'], cwd: '/workspace', invocationId: 'initial' };
  for (let index = 0; index < 256; index += 1) {
    rememberCodexAppServerControlOptions(pool, `session-${index}`, options);
  }
  assert.ok(resolveCodexAppServerControlOptions(pool, 'session-0', 'touch-session-0'));
  rememberCodexAppServerControlOptions(pool, 'session-overflow', options);

  assert.ok(resolveCodexAppServerControlOptions(pool, 'session-0', 'resolved-session-0'));
  assert.equal(resolveCodexAppServerControlOptions(pool, 'session-1', 'evicted-session-1'), null);
  assert.ok(resolveCodexAppServerControlOptions(pool, 'session-overflow', 'resolved-overflow'));
});
