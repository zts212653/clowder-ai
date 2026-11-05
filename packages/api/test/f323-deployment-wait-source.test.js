import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRegisterDeploymentWait } from '../../mcp-server/dist/tools/callback-tools.js';
import { withInvocationCredentials } from '../../mcp-server/dist/tools/invocation-auth.js';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { fixture, registerRequest } from './helpers/f323-deployment-wait-harness.js';

async function harness(t, options) {
  const h = await fixture({ included: false, ...options });
  t.after(() => h.app.close());
  const active = () => h.invocationTracker.getActiveSlots(h.auth.threadId)[0].activeRun;
  const adoptHold = (suffix, scope = {}) => {
    const holdTaskId = `hold-${suffix}`;
    const message = h.messageStore.append({
      from: { kind: 'system', service: 'hold-ball' },
      userId: h.auth.userId,
      threadId: h.auth.threadId,
      content: 'Command complete.',
      mentions: [],
      timestamp: 102,
      source: {
        connector: 'hold-ball',
        label: 'command',
        icon: 'hold-ball',
        meta: {
          wakeWhen: true,
          managedHold: true,
          phase: 'wake',
          taskId: holdTaskId,
          threadId: h.auth.threadId,
          catId: h.auth.catId,
          ...scope,
        },
      },
    });
    assert.equal(
      h.invocationTracker.adoptLifecycleActiveRunInputs(
        h.auth.threadId,
        h.auth.catId,
        { invocationId: h.auth.invocationId, responseMessageId: active().responseMessageId },
        `entry-${suffix}`,
        [message.id],
      ),
      true,
    );
    return { sourceMessageId: message.id, holdTaskId };
  };
  return {
    ...h,
    adoptHold,
    active,
    register: (overrides) => h.app.inject(registerRequest(h.auth, h.task, overrides)),
    resolve: (source) =>
      resolveTypedWaitContinuation({
        taskStore: h.taskStore,
        invocationId: h.auth.invocationId,
        userId: h.auth.userId,
        catId: h.auth.catId,
        threadId: h.auth.threadId,
        ...source,
      }),
  };
}

for (const count of [1, 2, 3]) {
  test(`deployment registration with ${count} adopted holds binds only its original input`, async (t) => {
    const h = await harness(t);
    const holds = Array.from({ length: count }, (_, i) => h.adoptHold(String(i)));
    const response = await h.register();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().disposition, 'registered');
    assert.equal(response.json().await.autoRenew, false);
    assert.deepEqual(h.taskStore.getWaitRegistration(h.task.id).receipt.source, {
      kind: 'primary',
      sourceMessageId: h.origin.id,
    });
    assert.equal((await h.resolve({ sourceMessageId: h.origin.id })).kind, 'bypass');
    for (const hold of holds) assert.equal((await h.resolve(hold)).kind, 'reject');
    const replay = await h.register();
    assert.equal(replay.json().disposition, 'already_registered');
    assert.equal(replay.json().await.generation, 1);
    assert.equal(h.getWakes(), 0);
  });
}

test('a managed primary source remains exact when other managed inputs are adopted', async (t) => {
  const h = await harness(t);
  const primary = h.adoptHold('primary');
  h.auth.originTriggerMessageId = primary.sourceMessageId;
  const other = h.adoptHold('other');
  const response = await h.register();
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(h.taskStore.getWaitRegistration(h.task.id).receipt.source, { kind: 'primary', ...primary });
  assert.equal((await h.resolve(primary)).kind, 'bypass');
  assert.equal((await h.resolve(other)).kind, 'reject');
  assert.equal((await h.resolve({ sourceMessageId: h.origin.id })).kind, 'reject');
  assert.equal((await h.resolve({ sourceMessageId: primary.sourceMessageId })).kind, 'reject');
});

test('already-loaded deployment with multiple holds returns the outcome to the current child only', async (t) => {
  const h = await harness(t, { included: true });
  h.adoptHold('one');
  h.adoptHold('two');
  const response = await h.register();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().disposition, 'matched_current_execution');
  assert.equal(response.json().notification.outcome.reason, 'matched');
  assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt.source.sourceMessageId, h.origin.id);
  assert.equal(h.getWakes(), 0);
  assert.equal(h.connector.admitted(h.auth.threadId, h.auth.userId).length, 0);
});

test('new target advances the same Task generation; a missing origin cannot replace that wait', async (t) => {
  const h = await harness(t);
  assert.equal((await h.register()).statusCode, 200);
  h.adoptHold('one');
  h.adoptHold('two');
  const updated = await h.register({ when: { kind: 'new_ready_boot', services: ['api'] } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().await.generation, 2);
  const snapshot = structuredClone(h.taskStore.getWaitRegistration(h.task.id));
  h.auth.originTriggerMessageId = 'missing-origin';
  const rejected = await h.register();
  assert.equal(rejected.statusCode, 409);
  assert.deepEqual(h.taskStore.getWaitRegistration(h.task.id), snapshot);
});

const invalidOrigins = [
  [
    'not in active inputs',
    (h) => {
      h.auth.originTriggerMessageId = 'not-an-input';
    },
  ],
  ['wrong thread', (_h, origin) => ({ ...origin, threadId: 'other-thread' })],
  ['wrong user', (_h, origin) => ({ ...origin, userId: 'other-user' })],
  ['deleted', (_h, origin) => ({ ...origin, deletedAt: 123 })],
  ['tombstone', (_h, origin) => ({ ...origin, _tombstone: true })],
  ['missing record', () => null],
  [
    'unavailable History',
    () => {
      throw new Error('History unavailable');
    },
  ],
];
for (const [name, transform] of invalidOrigins) {
  test(`deployment fails closed for ${name} even with a valid adopted hold`, async (t) => {
    const h = await harness(t);
    h.adoptHold('otherwise-valid');
    const getById = h.messageStore.getById.bind(h.messageStore);
    if (name === 'not in active inputs') transform(h);
    else h.messageStore.getById = (id) => (id === h.origin.id ? transform(h, getById(id)) : getById(id));
    const response = await h.register();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
    assert.equal(h.taskStore.getWaitRegistration(h.task.id)?.receipt ?? null, null);
  });
}

for (const [name, scope] of [
  ['foreign cat', { catId: 'opus' }],
  ['invalid task', { taskId: '' }],
  ['wrong source thread', { threadId: 'other-thread' }],
  ['not managed', { managedHold: false }],
]) {
  test(`a ${name} managed primary cannot borrow an adopted hold's authority`, async (t) => {
    const h = await harness(t);
    const primary = h.adoptHold('invalid', scope);
    h.auth.originTriggerMessageId = primary.sourceMessageId;
    h.adoptHold('otherwise-valid');
    const response = await h.register();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
  });
}

test('an unrelated adopted source neither blocks the Task owner nor gains continuation', async (t) => {
  const h = await harness(t);
  const foreign = h.adoptHold('foreign', { catId: 'opus' });
  const response = await h.register();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await h.resolve({ sourceMessageId: h.origin.id })).kind, 'bypass');
  assert.equal((await h.resolve(foreign)).kind, 'reject');
});

test('without the exact active invocation no source can register a deployment wait', async (t) => {
  const h = await harness(t);
  h.adoptHold('one');
  h.invocationTracker.getActiveSlots = () => [];
  const response = await h.register();
  assert.equal(response.statusCode, 409);
  assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
});

test('compiled MCP over HTTP registers through mixed inputs and one later deployment returns to the owner', async (t) => {
  const h = await harness(t);
  h.adoptHold('build');
  h.adoptHold('test');
  // Replay the reported consumer's target against isolated stores, never its live Task.
  const target = 'e924fa35b52df6b6562958f274853d225b6e3898';
  h.observation.inclusionProof.targetRevision = target;
  const originalApi = process.env.CAT_CAFE_API_URL;
  t.after(() => {
    if (originalApi === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = originalApi;
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  process.env.CAT_CAFE_API_URL = h.app.listeningOrigin;
  const request = {
    taskId: h.task.id,
    deploymentId: 'runtime',
    when: { kind: 'revision_included', revision: target, services: ['api'] },
    nextStep: 'Verify the original consumer after its real runtime loads PR5695.',
  };
  const call = () => withInvocationCredentials(h.auth, () => handleRegisterDeploymentWait(request));
  const result = await call();
  assert.equal(result.isError, undefined, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.disposition, 'registered');
  assert.equal(body.await.generation, 1);
  assert.equal(body.await.autoRenew, false);
  assert.equal((await h.taskStore.get(h.task.id)).status, 'blocked');
  assert.equal(JSON.parse((await call()).content[0].text).disposition, 'already_registered');
  assert.equal(h.getWakes(), 0);

  h.observation.bootId = 'boot-8';
  h.observation.bootSequence = 8;
  h.observation.inclusionProof.included = true;
  const delivered = await h.lifecycle.observe({ taskId: h.task.id, observation: h.observation });
  assert.equal(delivered.kind, 'notified');
  assert.equal(delivered.outcome.reason, 'matched');
  assert.equal(h.getWakes(), 1);
  assert.equal(h.connector.wakes[0].catId, h.auth.catId);
  assert.equal(h.connector.wakes[0].threadId, h.auth.threadId);
  const replay = await h.lifecycle.observe({ taskId: h.task.id, observation: h.observation });
  assert.equal(replay.kind, 'deduped');
  assert.equal(h.getWakes(), 1);
  t.diagnostic(
    JSON.stringify({
      url: h.app.listeningOrigin,
      target,
      disposition: body.disposition,
      generation: body.await.generation,
      outcome: delivered.outcome.reason,
      ownerWakes: h.getWakes(),
    }),
  );
});
