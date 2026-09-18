import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
    this.hashes = new Map();
    this.options = {};
  }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key) {
    return this.kv.get(key) ?? null;
  }
  async zadd(key, score, member) {
    const entries = this.sorted.get(key) ?? new Map();
    entries.set(member, score);
    this.sorted.set(key, entries);
    return 1;
  }
  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }
  async zrevrange(key, start, stop) {
    return [...(this.sorted.get(key)?.entries() ?? [])]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1)
      .map(([member]) => member);
  }
  async sadd(key, ...members) {
    const values = this.sets.get(key) ?? new Set();
    for (const member of members) values.add(member);
    this.sets.set(key, values);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async scan() {
    return ['0', []];
  }
  async hget() {
    return null;
  }
}

function summary(turnId = 'trace-turn-1') {
  return {
    turnId,
    threadId: 'thread-1',
    catId: 'cat-1',
    timestamp: 100,
    segments: [],
    delivery: [],
    totalCharCount: 0,
    totalTokenEstimate: 0,
    totalSegmentsObserved: 0,
    totalSegmentsAbsent: 0,
    durationMs: 0,
  };
}

function detail(turnId = 'trace-turn-1') {
  return {
    turnId,
    threadId: 'thread-1',
    catId: 'cat-1',
    timestamp: 100,
    sessionContentHash: null,
    turnContentHash: null,
    sessionCharCount: 0,
    sessionTokenEstimate: 0,
    turnCharCount: 0,
    turnTokenEstimate: 0,
    segments: [],
  };
}

function terminal(overrides = {}) {
  return {
    traceTurnId: 'trace-turn-1',
    invocationId: 'inv-1',
    ownerUserId: 'user-1',
    threadId: 'thread-1',
    catId: 'cat-1',
    inputMessageId: 'message-in',
    outputMessageId: 'message-out',
    terminalAt: 200,
    terminalKind: 'completed',
    toolCalls: [],
    ...overrides,
  };
}

describe('F257 exact trace episode correlation', () => {
  test('trace first then terminal closes an episode addressable by invocationId', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    await store.persist(summary(), detail());

    assert.deepEqual(await store.closeEpisode(terminal()), { outcome: 'created' });
    const episode = await store.getEpisodeByInvocationId('inv-1');
    assert.equal(episode.summary.turnId, 'trace-turn-1');
    assert.equal(episode.terminal.outputMessageId, 'message-out');
  });

  test('terminal first remains readable after the prompt trace arrives', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());

    await store.closeEpisode(terminal());
    assert.equal(await store.getEpisodeByInvocationId('inv-1'), null);
    await store.persist(summary(), detail());

    const episode = await store.getEpisodeByInvocationId('inv-1');
    assert.equal(episode.summary.threadId, 'thread-1');
    assert.equal(episode.terminal.invocationId, 'inv-1');
  });

  test('identical terminal retry is idempotent', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());

    assert.deepEqual(await store.closeEpisode(terminal()), { outcome: 'created' });
    assert.deepEqual(await store.closeEpisode(terminal()), { outcome: 'duplicate' });
  });

  test('conflicting terminal retry fails closed without overwriting the canonical episode', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    await store.closeEpisode(terminal());

    await assert.rejects(
      () => store.closeEpisode(terminal({ outputMessageId: 'other-output' })),
      /trace_episode_terminal_conflict/,
    );
    assert.equal((await store.getTerminalByInvocationId('inv-1')).outputMessageId, 'message-out');
  });
});
