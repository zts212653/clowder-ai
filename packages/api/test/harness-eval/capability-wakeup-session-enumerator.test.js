import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCapabilityWakeupRuntimeSessionEnumerator } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-session-enumerator.js';

function record({
  sessionId,
  lastObservedAt,
  startedAt = lastObservedAt - 10,
  userId = 'default-user',
  threadId = `thread-${sessionId}`,
  catId = 'codex',
}) {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId: `runtime-${sessionId}`,
    threadId,
    catId,
    userId,
    surface: 'ide-direct',
    identityHistory: [],
    lifecycle: { state: 'sealed', startedAt, lastObservedAt },
  };
}

describe('createCapabilityWakeupRuntimeSessionEnumerator', () => {
  it('paginates recent runtime sessions and filters by owner before replay refs', async () => {
    const offsets = [];
    const runtimeSessionStore = {
      listRecent: async ({ limit, offset }) => {
        offsets.push({ limit, offset });
        if (offset === 0) {
          return [
            record({ sessionId: 'too-new', lastObservedAt: 300 }),
            record({ sessionId: 'spans-window-end', startedAt: 50, lastObservedAt: 250 }),
          ];
        }
        if (offset === 2) {
          return [
            record({ sessionId: 'other-new', lastObservedAt: 250, userId: 'other-user' }),
            record({ sessionId: 'other-in-window', lastObservedAt: 160, userId: 'other-user' }),
          ];
        }
        if (offset === 4) {
          return [
            record({ sessionId: 'match', lastObservedAt: 150 }),
            record({ sessionId: 'missing-owner', lastObservedAt: 140, userId: null }),
          ];
        }
        if (offset === 6) {
          return [
            record({ sessionId: 'missing-thread', lastObservedAt: 130, threadId: '' }),
            record({ sessionId: 'before-window', lastObservedAt: 90 }),
          ];
        }
        return [];
      },
    };
    const enumerator = createCapabilityWakeupRuntimeSessionEnumerator({
      runtimeSessionStore,
      pageSize: 2,
      getFamilyForCat: (catId) => (catId === 'codex' ? 'maine-coon' : undefined),
    });

    const refs = await enumerator.listWindow({
      windowStartMs: 100,
      windowEndMs: 200,
      ownerUserId: 'default-user',
    });

    assert.deepEqual(offsets, [
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
      { limit: 2, offset: 4 },
      { limit: 2, offset: 6 },
    ]);
    assert.deepEqual(refs, [
      {
        sessionId: 'spans-window-end',
        threadId: 'thread-spans-window-end',
        catId: 'codex',
        userId: 'default-user',
        family: 'maine-coon',
      },
      {
        sessionId: 'match',
        threadId: 'thread-match',
        catId: 'codex',
        userId: 'default-user',
        family: 'maine-coon',
      },
    ]);
  });
});
