import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = Promise.all([
  import('../dist/domains/cats/services/agents/invocation/native-goal-observation.js'),
  import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
  import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
]);

test('native goal observations mutate only the exact active SessionChain binding', async () => {
  const [{ applyNativeGoalObservation, projectNativeGoalMessage }, { ThreadStore }, { SessionChainStore }] =
    await modules;
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const thread = threadStore.create('owner-1', 'Goal notifications');
  sessionChainStore.create({
    cliSessionId: 'native-current',
    threadId: thread.id,
    catId: 'codex',
    userId: 'owner-1',
  });

  const stale = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: updated('native-stale', 100),
  });
  assert.equal(stale, null);
  assert.equal((await threadStore.get(thread.id)).goal, undefined);

  const whitespace = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: { ...updated('native-current', 100), objective: '   ' },
  });
  assert.equal(whitespace, null);
  assert.equal((await threadStore.get(thread.id)).goal, undefined);

  const accepted = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: updated('native-current', 101),
  });
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.status, 'paused');
  assert.equal((await threadStore.get(thread.id)).goal.objective, 'Provider update');

  const projected = await projectNativeGoalMessage({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    message: {
      type: 'provider_signal',
      catId: 'codex',
      nativeGoalObservation: updated('native-current', 102),
      timestamp: 102,
    },
  });
  assert.equal(projected.semanticEvent.kind, 'goal');
  assert.equal(projected.semanticEvent.revision, 2);
  assert.equal(projected.nativeGoalObservation, undefined);
});

test('a durable clear fence rejects duplicate and late updated notifications', async () => {
  const [{ applyNativeGoalObservation }, { ThreadStore }, { SessionChainStore }] = await modules;
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const thread = threadStore.create('owner-1', 'Goal clear fence');
  sessionChainStore.create({
    cliSessionId: 'native-current',
    threadId: thread.id,
    catId: 'codex',
    userId: 'owner-1',
  });
  await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: updated('native-current', 101),
  });
  const cleared = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: { state: 'cleared', runtimeSessionId: 'native-current', source: 'codex_app_server' },
  });
  assert.equal(cleared.state, 'cleared');
  assert.equal(cleared.revision, 2);
  assert.equal((await threadStore.get(thread.id)).goal.intent, 'clear');

  const duplicateClear = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: { state: 'cleared', runtimeSessionId: 'native-current', source: 'codex_app_server' },
  });
  const lateUpdate = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: updated('native-current', 100),
  });
  assert.equal(duplicateClear, null);
  assert.equal(lateUpdate, null);
  assert.equal((await threadStore.get(thread.id)).goal.intent, 'clear');
  assert.equal((await threadStore.get(thread.id)).goal.revision, 2);
});

test('an older provider notification cannot overwrite a newer local set intent', async () => {
  const [{ applyNativeGoalObservation }, { ThreadStore }, { SessionChainStore }] = await modules;
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const thread = threadStore.create('owner-1', 'Goal intent fence');
  sessionChainStore.create({
    cliSessionId: 'native-current',
    threadId: thread.id,
    catId: 'codex',
    userId: 'owner-1',
  });
  const localIntent = {
    v: 1,
    intent: 'set',
    objective: 'New owner intent',
    status: 'active',
    tokenBudget: null,
    revision: 1,
    updatedAt: 200,
    sync: { state: 'syncing', source: 'cat_cafe', catId: 'codex' },
  };
  assert.equal(await threadStore.compareAndSetGoal(thread.id, null, localIntent), true);

  const stale = await applyNativeGoalObservation({
    threadStore,
    sessionChainStore,
    threadId: thread.id,
    userId: 'owner-1',
    catId: 'codex',
    observation: updated('native-current', 100),
  });

  assert.equal(stale, null);
  assert.deepEqual((await threadStore.get(thread.id)).goal, localIntent);
});

function updated(runtimeSessionId, providerUpdatedAt) {
  return {
    state: 'updated',
    runtimeSessionId,
    objective: 'Provider update',
    status: 'paused',
    tokenBudget: 200,
    providerUpdatedAt,
    source: 'codex_app_server',
  };
}
