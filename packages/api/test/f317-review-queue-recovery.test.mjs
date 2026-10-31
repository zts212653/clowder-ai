import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
// Ordinary and Live delivery use the same exact response contract. A failure
// in one source's admission/readback cannot seize or block its sibling.
for (const failure of ['before-commit', 'after-commit']) {
  test('Live admission failure preserves sibling ordinary Queue dispatch: ' + failure, async (t) => {
    let f;
    const starts = [];
    let finish;
    const finished = new Promise((r) => {
      finish = r;
    });
    const router = {
      resolveExplicitTargets: async (cats) => cats,
      resolveConversationTargetsAtAdmission: async (cats) => cats,
      async *routeExecution(...args) {
        const [userId, , threadId, , cats, , options] = args;
        starts.push([...cats]);
        const invocationId = 'ordinary-kimi';
        const startedAt = Date.now();
        f.turns.createRunning({
          invocationId,
          parentInvocationId: options.parentInvocationId,
          threadId,
          userId,
          catId: cats[0],
          executionKind: 'ordinary',
          startedAt,
        });
        const admission = await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: cats[0],
          invocationId,
          parentInvocationId: options.parentInvocationId,
          startedAt,
        });
        f.turns.transitionTerminal(invocationId, { status: 'succeeded', endedAt: Date.now() });
        yield {
          type: 'system_info',
          catId: cats[0],
          turnInvocationId: invocationId,
          lifecycleResponseMessageId: admission.responseMessageId,
          activeRun: admission.activeRun,
          content: JSON.stringify({ type: 'invocation_created', invocationId }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: cats[0], isFinal: true, timestamp: Date.now() };
        finish();
      },
      async ackCollectedCursors() {},
    };
    f = await fixture(intent, 'agent', { router });
    t.after(f.close);
    const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
    f.store.commitLifecycleAppendAdmission = async (input) => {
      if (failure === 'after-commit') await commit(input);
      throw new Error('fixture admission outage');
    };
    assert.equal((await f.read()).statusCode, 503);
    const refs = f.store.getById(f.message.id).lifecycle.dispatchRefs ?? [];
    assert.equal(refs.length, failure === 'after-commit' ? 1 : 0);
    assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
    f.store.commitLifecycleAppendAdmission = commit;
    if (failure === 'before-commit') {
      assert.equal(
        (await f.processor.processNext('home', 'owner')).started,
        false,
        'the ordinary multi-target batch cannot replace its still-busy Live target',
      );
      assert.deepEqual(starts, []);
      assert.equal(
        (await f.read()).statusCode,
        200,
        'retry resumes the original exact Live response before the sibling becomes eligible',
      );
    }
    assert.equal((await f.processor.processNext('home', 'owner')).started, true);
    await finished;
    assert.deepEqual(starts, [['kimi']], 'the busy Live child must not be replaced');
    assert.equal(f.store.getById(f.response.id).lifecycle.invocationId, f.auth.invocationId);
    const input = f.store.getById(f.message.id);
    assert.ok(input.lifecycle.dispatchRefs.some((ref) => ref.targetId === 'kimi'));
    assert.equal(input.lifecycle.dispatchRefs.filter((ref) => ref.targetId === 'codex-astra').length, 1);
  });
}

test('ordinary activity cannot finish an unrelated Live source or change its exact response identity', async (t) => {
  const f = await fixture(intent, 'agent');
  t.after(f.close);
  const before = structuredClone(f.store.getById(f.response.id));
  assert.equal(
    (
      await f.store.commitLifecycleResponseTerminal(f.response.id, {
        invocationId: 'ordinary-other-child',
        status: 'completed',
        completedAt: Date.now(),
        content: 'unrelated result',
        extra: before.extra,
        mentions: [],
        origin: 'stream',
      })
    ).kind,
    'conflict',
  );
  assert.deepEqual(f.store.getById(f.response.id), before);
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['codex-astra', 'kimi']);
  assert.equal((await f.read()).statusCode, 200);
  assert.equal(f.store.getById(f.response.id).lifecycle.invocationId, f.auth.invocationId);
  assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
  assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
});
