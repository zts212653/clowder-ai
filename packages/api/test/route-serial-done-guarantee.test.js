/**
 * #30 fix: Tests for done(isFinal=true) terminal event guarantee
 *
 * Verifies that routeSerial ALWAYS yields done(isFinal=true) even when:
 * 1. The agent service does not yield a done event
 * 2. The invocation is aborted via AbortSignal
 * 3. Normal flow with multiple cats completes correctly
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

function createMockDeps(services) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://localhost:3102',
    },
    messageStore: {
      append: async () => ({
        id: `msg-${counter}`,
        userId: '',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('#30 done(isFinal) guarantee', () => {
  it('synthesizes done(isFinal=true) when agent service yields no done', async () => {
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() };
        // Deliberately NOT yielding done
      },
    };

    const deps = createMockDeps({ opus: service });
    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user-1', 'thread-1')) {
      messages.push(msg);
    }

    const doneMessages = messages.filter((m) => m.type === 'done');
    assert.ok(doneMessages.length >= 1, 'should have at least one done message');

    const finalDone = doneMessages.find((m) => m.isFinal === true);
    assert.ok(finalDone, 'should have a done with isFinal=true');
    assert.equal(finalDone.catId, 'opus');
  });

  it('yields done(isFinal=true) on signal abort', async () => {
    const ac = new AbortController();
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'starting...', timestamp: Date.now() };
        // Simulate long-running work — abort fires during iteration
        ac.abort();
        yield { type: 'text', catId: 'opus', content: 'more text', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: service });
    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user-1', 'thread-1', {
      signal: ac.signal,
    })) {
      messages.push(msg);
    }

    const finalDone = messages.find((m) => m.type === 'done' && m.isFinal === true);
    assert.ok(finalDone, 'should have a done with isFinal=true even after abort');
  });

  it('normal multi-cat flow yields exactly one done(isFinal=true) for last cat', async () => {
    const opusService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'opus reply', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const codexService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'codex reply', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: opusService, codex: codexService });
    const messages = [];
    for await (const msg of routeSerial(deps, ['opus', 'codex'], 'test', 'user-1', 'thread-1')) {
      messages.push(msg);
    }

    const doneMessages = messages.filter((m) => m.type === 'done');
    assert.equal(doneMessages.length, 2, 'should have two done messages (one per cat)');
    assert.equal(doneMessages[0].isFinal, false, 'first cat done should not be isFinal');
    assert.equal(doneMessages[1].isFinal, true, 'last cat done should be isFinal');
    assert.equal(doneMessages[1].catId, 'codex');
  });

  it('does not double-emit done(isFinal=true) in normal flow', async () => {
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'reply', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: service });
    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user-1', 'thread-1')) {
      messages.push(msg);
    }

    const finalDones = messages.filter((m) => m.type === 'done' && m.isFinal === true);
    assert.equal(finalDones.length, 1, 'should have exactly one done(isFinal=true)');
  });
});
