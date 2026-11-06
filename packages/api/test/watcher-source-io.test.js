import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { watcherWorld } from './helpers/watcher-world.js';

const { runWatcherInvocation } = await import(
  process.env.F335_WATCHER_REVIEW_RED_MODULE ?? '../dist/domains/concierge/watcher/watcher-invocation.js'
);
test(
  'an unresolved original-source read is inside the wake deadline and releases the lane',
  { timeout: 10000 },
  async () => {
    const w = await watcherWorld();
    const [source] = await w.work('First committed reply.');
    const session = await w.sessions.getOrCreateActive({
      userId: 'watcher-owner',
      threadId: w.thread.id,
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey('watcher-owner', 'codex', w.thread.id),
    });
    let read = false,
      released = false;
    const messages = new Proxy(w.messages, {
      get(target, key) {
        if (key === 'getById')
          return () => {
            read = true;
            return new Promise(() => {});
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let timeout;
    const service = {
      boundedWatcherSessionCapability: () => ({ supported: true }),
      releaseInvocation: async () => {
        released = true;
      },
      async *invoke() {
        assert.fail('the source has not been read');
      },
    };
    const result = await Promise.race([
      runWatcherInvocation(
        { ...w, messages, transcript: {}, apiUrl: 'http://127.0.0.1:1', maySpeak: async () => true },
        { source, session, service, quiet: false, deadlineMs: 30 },
      ).then(
        () => 'unexpected_success',
        (error) => error.message,
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('read_stranded_outside_deadline'), 1000);
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(read, true);
    assert.equal(result, 'watcher_deadline_exceeded');
    assert.equal(released, true);
    const next = await w.work('Next work is still independent.');
    assert.equal(next[0].status, 'succeeded');
  },
);
