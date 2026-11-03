import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { isPluginDeliveryInput } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createMessagingDomain } from '../src/domains/messaging/index.js';
import { createMessagingStores } from '../src/domains/messaging/stores/factory.js';
import { createSubscriptionDelivery } from '../src/domains/messaging/subscription-delivery.js';
import { createModuleHostInvocation } from '../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { currentOwnerOperation } from '../src/domains/plugin/carrier/plugin-owner-operation-context.js';
import { createPluginMessagingSubscriptionSession } from '../src/domains/plugin/host-surface/plugin-messaging-subscription-host.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';
import { createMemberSessionHost } from '../src/domains/plugin/member-sessions/host.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

// Feasibility probe: real Host subscription/carrier/admission, in-memory stores
// and a fake Queue sink. This neither installs a plugin nor runs a model.
async function fixture() {
  const f = memberSessionFixture();
  const threads = new ThreadStore();
  const deps = {
    ...f.deps,
    assertThread: async (owner: string, threadId: string, catId: string) => {
      const thread = threads.get(threadId);
      assert.ok(thread);
      assert.equal(thread.createdBy, owner);
      assert.ok(thread.participants.some((id) => id === catId));
    },
    threadCreation: {
      workspace: async () => resolve('artifacts/superagent-contract-probe'),
      store: threads,
    },
  };
  const scope = { ...f.scope(), activationId: 'activation-1' };
  const port = createMemberSessionHost(createPluginMemberSessions(deps)).forInstance(scope);
  const { threadId: _unused, ...member } = f.prepareInput;
  const grant = await f.owner(() => port.create({ ...member, title: 'Coordinator probe' }));
  return { ...f, threads, deps, scope, port, grant };
}

test('selected-thread delivery can use a confirmed grant without borrowing callback authority; replay does not wake twice', async () => {
  const f = await fixture();
  const selected = await f.threads.create('owner', 'Selected conversation');
  const outside = await f.threads.create('owner', 'Not selected');
  const messaging = createMessagingDomain({ messageStore: new MessageStore(), stores: createMessagingStores() });
  const observed: string[] = [];
  let loseReceipt = true;
  const actions = {
    async observe(value: unknown) {
      assert.ok(isPluginDeliveryInput(value));
      assert.equal(currentOwnerOperation('installed'), undefined, 'a delivery is not a new owner operation');
      if (value.kind === 'message') {
        observed.push(value.threadId);
        const run = await f.port.execute({
          sessionId: f.grant.sessionId,
          generation: f.grant.generation,
          executionId: value.deliveryId,
          semanticCursor: 1, // One semantic input in this probe; delivery envelopes expose no global cursor.
          content: JSON.stringify(value.envelope),
        });
        assert.equal(run.phase, 'queued');
        if (loseReceipt) {
          loseReceipt = false;
          throw new Error('simulated_exit_before_subscription_ack');
        }
      }
      return { deliveryId: value.deliveryId };
    },
  };
  const invocation = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const delivery = createSubscriptionDelivery({
    messaging,
    presentation: async (threadId, actor) => ({
      actor: { displayName: actor.id, emoji: '🐾' },
      thread: { shortId: threadId },
    }),
    delivery: {
      invoke: invocation.invoke,
      deliver: async () => {
        throw new Error('module action required');
      },
    },
  });
  const subscription = createPluginMessagingSubscriptionSession({
    pluginId: 'dev.clowder.superagent-probe',
    pluginInstanceId: 'installed',
    ownerUserId: 'owner',
    threadStore: f.threads,
    messaging,
    delivery,
  });
  await subscription.host.subscribe({ threadId: selected.id, method: 'observe' });
  const publish = async (threadId: string, producer: string) => {
    const { handleId } = await messaging.issueThreadHandle({
      pluginInstanceId: producer,
      threadId,
      userId: 'owner',
      scope: { canSend: true, canSubscribe: false },
    });
    await messaging.send(
      { pluginInstanceId: producer },
      {
        address: { kind: 'thread_handle', handle: handleId },
        idempotencyKey: `${producer}:${threadId}`,
        payload: {
          provenance: { epistemicStatus: 'observation' },
          elements: [{ elementId: 'probe-event', kind: 'text', payload: { text: 'Synthetic event' } }],
        },
      },
    );
  };
  await publish(outside.id, 'synthetic-source');
  await delivery.drain(outside.id);
  await publish(selected.id, 'installed');
  await delivery.drain(selected.id);
  assert.deepEqual(observed, [], 'outside threads and own-message echoes do not reach the action');
  await publish(selected.id, 'synthetic-source');
  await assert.rejects(delivery.drain(selected.id), /simulated_exit_before_subscription_ack/);
  await delivery.drain(selected.id);
  await delivery.drain(selected.id);
  assert.deepEqual(observed, [selected.id, selected.id], 'the unacknowledged delivery is replayed once');
  assert.equal(f.sends(), 1, 'the original member execution is reused after the lost receipt');
  await subscription.stop('owner_disabled');
  await publish(selected.id, 'after-disable');
  await delivery.drain(selected.id);
  assert.equal(observed.length, 2);
  await f.owner(() => f.port.revoke(f.grant.sessionId), 'owner-stop');
  assert.equal((await f.port.get(f.grant.sessionId))?.revoked, true);
});

test('a restart preserves the protected thread but cannot automatically renew its member grant', async () => {
  const f = await fixture();
  const scope = { ...f.scope, activationId: 'activation-2' };
  const port = createMemberSessionHost(createPluginMemberSessions(f.deps)).forInstance(scope);
  const input = {
    sessionId: f.grant.sessionId,
    generation: f.grant.generation,
    executionId: 'event-after-restart',
    semanticCursor: 1,
    content: 'Synthetic event after restart',
  };
  assert.equal((await port.get(f.grant.sessionId))?.threadId, f.grant.threadId);
  await assert.rejects(port.execute(input), /member_session_activation_changed/);
  const prepare = { ...f.prepareInput, threadId: f.grant.threadId };
  await assert.rejects(port.prepare(prepare), /member_session_owner_authority_required/);
  assert.equal(f.sends(), 0);
  const renewed = await f.owner(() => port.prepare(prepare), 'owner-confirmed-resume');
  assert.equal(renewed.threadId, f.grant.threadId);
  assert.equal(renewed.generation, f.grant.generation + 1);
  assert.equal((await port.execute({ ...input, generation: renewed.generation })).phase, 'queued');
  assert.equal(f.threads.list('owner').length, 1, 'renewal reuses the original protected thread');
  assert.equal(f.sends(), 1);
});

test('canonical Work data accepts this installation own source, not an observed human message or an execution grant', async () => {
  const f = await fixture();
  catRegistry.register('member', {
    id: createCatId('member'),
    name: 'probe',
    displayName: 'Contract probe',
    avatar: '',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@member'],
    clientId: 'openai',
    carrier: 'cli',
    defaultModel: 'unused',
    mcpSupport: false,
    roleDescription: 'Synthetic test member',
    personality: 'Synthetic test member',
  });
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const human = messages.append({
    threadId: f.grant.threadId,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'Synthetic entrusted request',
    mentions: [],
    timestamp: 1,
  });
  const controller = {
    pluginId: 'dev.clowder.superagent-probe',
    pluginInstanceId: 'installed',
    moduleRef: 'plugin:dev.clowder.superagent-probe',
    lifecycleRevision: 1,
  };
  const host = createPluginTaskHost({
    pluginId: controller.pluginId,
    pluginInstanceId: controller.pluginInstanceId,
    ownerUserId: 'owner',
    taskStore: tasks,
    threadStore: f.threads,
    readThreadStore: f.threads,
    admission: {
      messageStore: messages,
      isCatAvailable: (catId) => catId === 'member',
      assertCurrent: async () => {},
      readCurrentDataControllerAuthority: async () => controller,
      withCurrentDataControllerAuthority: async (run) => run(controller),
    },
  });
  const input = {
    threadId: f.grant.threadId,
    kind: 'work' as const,
    title: 'Synthetic Work data',
    ownerCatId: 'member',
    subjectKey: 'superagent-probe:work',
    entrustedWork: {
      sourceMessageId: human.id,
      intendedOutcome: 'Contract probe only',
      closure: { condition: 'Owner accepts', expectedSignal: 'accepted' },
    },
  };
  await assert.rejects(host.create(input), /Task data source is not current for this installation/);
  assert.equal(tasks.listByThread(f.grant.threadId).length, 0);
  const source = messages.append({
    threadId: f.grant.threadId,
    userId: 'owner',
    from: { kind: 'plugin', instanceId: 'installed' },
    content: `Synthetic plugin judgment; observed source message:${human.id}`,
    mentions: [],
    timestamp: 2,
    extra: { pluginMessage: { instanceId: 'installed', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  const ownInput = { ...input, entrustedWork: { ...input.entrustedWork, sourceMessageId: source.id } };
  const work = await host.create(ownInput, { onConflict: 'update' });
  assert.deepEqual(work.entrustedWork?.admission.sourceRefs, [`message:${source.id}`]);
  assert.equal((await host.create(ownInput, { onConflict: 'update' })).id, work.id);
  assert.equal(tasks.listByThread(f.grant.threadId).length, 1);
  assert.equal(f.sends(), 0, 'admitting Work data does not dispatch a member');
});
