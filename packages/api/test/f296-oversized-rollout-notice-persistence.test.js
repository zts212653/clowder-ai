import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { isUserFacingSystemInfoContent } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function lifecycle(status, overrides = {}) {
  return JSON.stringify({
    type: 'session_rollover_lifecycle',
    v: 1,
    rolloverId: 'inv-oversized-1:codex-native-resume',
    status,
    reason: 'oversized_retire',
    ...overrides,
  });
}

async function persistedLifecycleMessages(store, contents) {
  await persistUserFacingSystemInfoNotices({
    messageStore: store,
    threadId: 'thread-owner',
    catId: 'codex-sol',
    contents,
  });
  return (await store.getByThread('thread-owner')).filter(
    (message) => message.source?.connector === 'session-rollover-lifecycle',
  );
}

describe('F296 oversized native rollover durable notices', () => {
  it('persists each lifecycle stage exactly once with no native-session payload leakage', async () => {
    const store = new MessageStore();
    const pending = lifecycle('pending');
    const succeeded = lifecycle('succeeded');

    assert.equal(isUserFacingSystemInfoContent(pending), true);
    const messages = await persistedLifecycleMessages(store, [pending, pending, succeeded, succeeded]);

    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => message.source.meta.sessionRollover.status),
      ['pending', 'succeeded'],
    );
    assert.deepEqual(
      messages.map((message) => message.source.meta.noticeTone),
      ['info', 'info'],
    );
    for (const message of messages) {
      assert.doesNotMatch(message.content, /native-oversized|rollout|prompt|inv-oversized-1/i);
    }
  });

  it('persists an honest failed stage and rejects malformed lifecycle payloads', async () => {
    const store = new MessageStore();
    const failed = lifecycle('failed', { failureStage: 'seal_finalize' });
    const messages = await persistedLifecycleMessages(store, [
      lifecycle('failed'),
      lifecycle('succeeded', { reason: 'invented_reason' }),
      lifecycle('pending', { rolloverId: '' }),
      lifecycle('pending', { v: 2 }),
      failed,
      failed,
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].source.meta.noticeTone, 'warning');
    assert.equal(messages[0].source.meta.sessionRollover.status, 'failed');
    assert.equal(messages[0].source.meta.sessionRollover.failureStage, 'seal_finalize');
    assert.match(messages[0].content, /失败/);
    assert.match(messages[0].content, /发送新 prompt 前停止/);
  });
});
