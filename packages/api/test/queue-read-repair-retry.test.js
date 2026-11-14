import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readRepairFixture } from './helpers/read-repair-fixture.js';

async function refusalFixture(t) {
  const h = await readRepairFixture(t);
  h.failure = new Error('storage_temporarily_unavailable');
  return h;
}

describe('active execution read-repair retry control', () => {
  it('repeated thread/project/all polls do one refused write and retain failed writes for retry', async (t) => {
    const h = await refusalFixture(t);
    for (const scope of ['thread', 'project', 'all', 'thread', 'project']) await h.poll(scope);
    assert.equal(h.transition.mock.callCount(), 1, 'unchanged refusal must not cause a write on every GET');
    assert.equal(h.errors().length, 1, 'the first refusal remains visible without repeating stacks');
    assert.match(h.errors()[0].err.message, /storage_temporarily_unavailable/);
    assert.equal(h.parent.status, 'running');
    const child = await h.turnExecutionStore.get(h.childId);
    assert.equal(child.status, 'running');
    assert.equal(child.providerTeardownAt, undefined);
    assert.equal(h.socketManager.broadcastAgentMessage.mock.callCount(), 0);
  });

  it('concurrent polls share one in-flight repair instead of racing the same terminal write', async (t) => {
    const h = await refusalFixture(t);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    h.beforeTransition = async () => {
      entered.resolve();
      await release.promise;
    };
    const polls = Array.from({ length: 9 }, (_, i) => h.poll(['thread', 'project', 'all'][i % 3]));
    t.after(() => release.resolve());
    await entered.promise;
    await setImmediate();
    release.resolve();
    await Promise.all(polls);
    assert.equal(h.transition.mock.callCount(), 1, 'all concurrent readers must share the same failed attempt');
    assert.equal(h.errors().length, 1);
  });

  it('new teardown proof retries immediately even when the parent revision is unchanged', async (t) => {
    const h = await refusalFixture(t);
    await h.poll();
    const parentRevision = h.parent.updatedAt;
    h.advance(1);
    h.failure = undefined;
    await h.turnExecutionStore.recordProviderTeardown(h.childId, Date.now());
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 2);
    assert.equal(h.parent.status, 'failed');
    assert.equal((await h.turnExecutionStore.get(h.childId)).status, 'failed');
    assert.ok(h.parent.updatedAt > parentRevision);
    assert.equal(h.errors().length, 1, 'successful recovery must not add another failure');
  });

  it('a changed parent revision unlocks retry and a different failure is reported', async (t) => {
    const h = await refusalFixture(t);
    h.failure = Object.assign(new Error('redis unavailable'), { code: 'ECONNRESET' });
    await h.poll();
    h.failure = new Error('storage_temporarily_unavailable');
    h.parent.updatedAt += 1;
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 2);
    assert.equal(h.errors().length, 2);
    assert.match(h.errors()[1].err.message, /storage_temporarily_unavailable/);
    assert.equal(h.parent.status, 'running');
  });

  for (const control of ['process owner', 'tracker', 'producer reservation', 'incomplete owner snapshot']) {
    it(`${control} changes release the old retry decision without retiring a live owner`, async (t) => {
      const h = await refusalFixture(t);
      await h.poll();
      if (control === 'process owner')
        h.owners.push({
          executionId: h.parent.id,
          invocationId: h.childId,
          threadId: h.threadId,
          userId: h.userId,
          catId: h.catId,
          startedAt: Date.now() - 60_000,
        });
      if (control === 'tracker') h.invocationTracker.start(h.threadId, h.catId, h.userId, [h.catId], h.parent.id);
      if (control === 'producer reservation') h.slot = true;
      if (control === 'incomplete owner snapshot') h.ownerComplete = false;
      await h.poll('thread', null);
      assert.equal(h.transition.mock.callCount(), 1, 'control truth must keep the live/unknown owner protected');
      h.owners.length = 0;
      h.invocationTracker.complete(h.threadId, h.catId);
      h.slot = false;
      h.ownerComplete = true;
      await h.poll();
      assert.equal(h.transition.mock.callCount(), 2, 'a changed control condition must not inherit the old cooldown');
      assert.equal(h.parent.status, 'running', 'a retry still respects the storage failure');
    });
  }

  it('bounded backoff probes changing failures, logs new exceptions and summarizes identical ones', async (t) => {
    const h = await refusalFixture(t);
    await h.poll();
    h.advance(30_000);
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 2, 'unchanged state still gets a bounded health probe');
    assert.equal(h.errors().length, 1, 'the same refusal does not repeat its stack at the probe');
    await h.poll();
    h.advance(59_999);
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 2, 'the second cooldown doubles');
    h.failure = Object.assign(new Error('new storage failure'), { code: 'EIO' });
    h.advance(1);
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 3);
    assert.equal(h.errors().length, 2, 'an unrelated exception must be visible after a known refusal');
    h.failure = Object.assign(new Error('new storage failure'), { code: 'EACCES' });
    h.advance(120_000);
    await h.poll();
    assert.equal(h.errors().length, 3, 'different error codes with the same message are distinct failures');
    h.advance(240_000);
    await h.poll();
    assert.equal(h.errors().length, 3);
    assert.ok(h.logs.some((line) => line.msg === 'active execution read-repair retry deferred' && !line.err));
    h.advance(300_000);
    await h.poll();
    assert.equal(h.transition.mock.callCount(), 6, 'backoff is capped so recovery can always be reprobed');
  });

  it('a new execution for the same cat never inherits an older execution refusal', async (t) => {
    const h = await refusalFixture(t);
    await h.poll();
    await h.addExecution('new-execution');
    h.advance(60_000);
    await h.poll();
    assert.equal(h.errors().length, 2, 'the new execution gets its own first-error evidence');
  });
});
