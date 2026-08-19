import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);

const scope = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

function openInput(overrides = {}) {
  return {
    closureId: 'closure-1',
    ...scope,
    invocationId: 'inv-base',
    originTriggerMessageId: 'msg-origin-1',
    draftContent: 'stale draft',
    requiredMessageIds: ['msg-2'],
    requiredFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: 100,
    ...overrides,
  };
}

describe('F254 Phase E — freshness closure store contract', () => {
  it('IR-3 keeps distinct pending lineages in one scope instead of merging drafts', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const closures = await Promise.all([
      store.openOrAdvance(openInput()),
      store.openOrAdvance(
        openInput({
          closureId: 'closure-racing',
          invocationId: 'inv-racing',
          originTriggerMessageId: 'msg-origin-2',
          draftContent: 'newer stale draft',
          requiredMessageIds: ['msg-3'],
          requiredFrontierMessageId: 'msg-3',
          observedRawFrontierMessageId: 'msg-3',
          now: 110,
        }),
      ),
    ]);
    assert.deepEqual(closures.map((closure) => closure.id).sort(), ['closure-1', 'closure-racing']);
    const active = await store.listActiveByScope(scope);
    assert.deepEqual(active.map((closure) => closure.id).sort(), ['closure-1', 'closure-racing']);
    assert.deepEqual((await store.get('closure-1')).requiredMessageIds, ['msg-2']);
    assert.deepEqual((await store.get('closure-racing')).requiredMessageIds, ['msg-3']);
  });

  it('IR-12 allows multiple lineages but grants only one running lease per scope', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.openOrAdvance(openInput());
    const second = await store.openOrAdvance(
      openInput({
        closureId: 'closure-2',
        invocationId: 'inv-base-2',
        originTriggerMessageId: 'msg-origin-2',
        draftContent: 'second stale draft',
        requiredMessageIds: ['msg-3'],
        requiredFrontierMessageId: 'msg-3',
        observedRawFrontierMessageId: 'msg-3',
      }),
    );
    const running = await store.claimAttempt(first.id, {
      invocationId: 'inv-successor',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    assert.equal(running.status, 'running');
    await assert.rejects(
      () =>
        store.claimAttempt(second.id, {
          invocationId: 'inv-successor-2',
          inputFrontierMessageId: 'msg-3',
          observedRawFrontierMessageId: 'msg-3',
          now: 201,
        }),
      /running lease/,
    );

    const committed = await store.commit(first.id, {
      invocationId: 'inv-successor',
      messageId: 'final-1',
      observedRawFrontierMessageId: 'msg-2',
      now: 300,
    });
    assert.equal(committed.status, 'committed');
    assert.deepEqual(
      (await store.listActiveByScope(scope)).map((closure) => closure.id),
      ['closure-2'],
    );
    const runningSecond = await store.claimAttempt(second.id, {
      invocationId: 'inv-successor-2',
      inputFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      now: 301,
    });
    assert.equal(runningSecond.status, 'running');
    assert.equal((await store.get(first.id)).committedMessageId, 'final-1');
  });

  it('deletes every closure detail and active index for a deleted thread', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.openOrAdvance(openInput());
    const second = await store.openOrAdvance(
      openInput({
        closureId: 'closure-2',
        catId: 'opus48',
      }),
    );
    assert.equal(await store.deleteByThread(scope.threadId), 2);
    assert.equal(await store.get(first.id), null);
    assert.equal(await store.get(second.id), null);
    assert.deepEqual(await store.listActiveByThread(scope.threadId), []);
  });

  it('recovers an orphan running attempt for startup requeue', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await store.openOrAdvance(openInput());
    await store.claimAttempt(opened.id, {
      invocationId: 'inv-crashed',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    const recovered = await store.recoverAttempt(opened.id, { evidenceRef: 'startup', now: 300 });
    assert.equal(recovered.status, 'pending');
    assert.equal((await store.listRecoverable()).length, 1);
  });

  it('blocks a pending startup closure without creating an invocation attempt', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const opened = await store.openOrAdvance(openInput());
    const blocked = await store.blockRecovery(opened.id, {
      evidenceRefs: ['startup:pending_requires_explicit_retry'],
      now: 500,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.deepEqual(blocked.attempts, []);
    assert.equal((await store.listRecoverable()).length, 0);
    assert.equal((await store.listActiveByThread(scope.threadId)).length, 1, 'blocked custody must hydrate after F5');
  });
});
