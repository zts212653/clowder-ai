import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  normalizeToolExecutionPolicy,
  parseToolExecutionPolicy,
} from '../src/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { ToolExecutionPolicy } from '../src/domains/cats/services/types.js';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { pluginNativeActionRoutes } from '../src/routes/plugin-native-action-routes.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture(t: TestContext, guarded = true) {
  const f = memberSessionFixture(),
    turns = new InMemoryTurnExecutionStore(),
    messages = new MessageStore();
  const service = createPluginMemberSessions({ ...f.deps, canonicalExecution: { turns, messages } });
  const port = service.forInstance(f.scope());
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'own-event',
    semanticCursor: 1,
    content: 'own local event',
  };
  const queued = await port.execute(input);
  assert.ok(queued.messageId);
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'installed',
    contributionId: 'player-tools',
    memberSession: { sessionId: session.sessionId, generation: session.generation, executionId: input.executionId },
  } as ToolExecutionPolicy;
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    'owner',
    createCatId('member'),
    'game-thread',
    undefined,
    undefined,
    policy,
    queued.messageId,
  );
  turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'parent',
    userId: 'owner',
    threadId: 'game-thread',
    catId: createCatId('member'),
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: 1,
    causal: { triggerMessageId: queued.messageId },
  });
  turns.markProviderStarted(auth.invocationId, 2);
  const response = messages.append({
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'agent', catId: createCatId('member') },
    content: '',
    mentions: [],
    timestamp: 1,
    lifecycle: {
      kind: 'response',
      orderKey: `1:${auth.invocationId}`,
      invocationId: auth.invocationId,
      targetId: 'member',
      inputEntryIds: ['entry'],
      inputMessageIds: [queued.messageId],
      status: 'processing',
      startedAt: 1,
    },
  });
  await service.hostExecutionsForInstance(f.scope()).claim({
    sessionId: input.sessionId,
    generation: input.generation,
    executionId: input.executionId,
    invocationId: auth.invocationId,
    responseMessageId: response.id,
  });
  let entered = 0;
  let beforeAdmission: (() => Promise<void>) | undefined, inHandler: (() => Promise<void>) | undefined;
  const admission = {
    instance: {
      pluginInstanceId: 'installed',
      packageDigest: 'package-v1',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      manifest: {
        features: [{ capabilities: [], contributions: [{ type: 'mcp', id: 'player-tools' }] }],
        contributions: [{ type: 'mcp', id: 'player-tools' }],
      },
    },
  };
  const actions = new NativePluginActions(async () => {
    await beforeAdmission?.();
    return admission as never;
  });
  actions.activate(admission as never, 0, async () => {
    entered++;
    await inHandler?.();
    return 'local private result';
  });
  const actionToken = actions.environment('installed', 'player-tools').CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(actionToken);
  t.after(() => actions.deactivateAll());
  const app = Fastify();
  t.after(() => app.close());
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry,
    sources: { messageStore: messages },
    threadStore: { get: async () => ({ createdBy: 'owner' }) },
    ...(guarded ? { assertMemberSessionCurrent: service.hostCallbackForInstance(f.scope()) } : {}),
  });
  return {
    ...f,
    port,
    session,
    registry,
    auth,
    policy,
    originalMessageId: queued.messageId,
    entered: () => entered,
    beforeAdmission: (run: () => Promise<void>) => {
      beforeAdmission = run;
    },
    inHandler: (run: () => Promise<void>) => {
      inHandler = run;
    },
    request: (credentials = auth) =>
      app.inject({
        method: 'POST',
        url: '/api/plugin-runtime/action',
        headers: {
          'x-invocation-id': credentials.invocationId,
          'x-callback-token': credentials.callbackToken,
          'x-clowder-plugin-action-token': actionToken,
        },
        payload: { method: 'player.observe', input: { generation: 999, catId: 'spoof' } },
      }),
  };
}

test('the exact member lease survives durable policy normalization without mutable aliases', () => {
  const input = {
    mode: 'plugin_native' as const,
    pluginInstanceId: 'installed',
    contributionId: 'player-tools',
    memberSession: { sessionId: 'grant', generation: 3, executionId: 'event' },
  };
  const normalized = normalizeToolExecutionPolicy(input);
  assert.deepEqual(normalized, input);
  assert.deepEqual(parseToolExecutionPolicy(JSON.stringify(input)), input);
  input.memberSession.generation = 4;
  assert.notDeepEqual(normalized, input);
});

test('a scoped native callback cannot enter a package when the Host member guard is unwired', async (t) => {
  const f = await fixture(t, false);
  const response = await f.request();
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(f.entered(), 0);
});

test('the real native route rechecks the canonical grant before every later tool call', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request()).statusCode, 200);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  const refused = await f.request();
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(f.entered(), 1);
});

test('account revision changes during awaited native admission prevent package entry', async (t) => {
  const f = await fixture(t);
  f.beforeAdmission(async () => {
    f.changeAccount();
  });
  const response = await f.request();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.entered(), 0);
});

test('a regrant during a package call withholds the old result', async (t) => {
  const f = await fixture(t);
  f.inHandler(async () => {
    await f.owner(() => f.port.revoke(f.session.sessionId));
    await f.owner(() => f.port.prepare(f.prepareInput), 'new-owner-grant');
  });
  const response = await f.request();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.body.includes('local private result'), false);
  assert.equal(f.entered(), 1);
});

test('a valid callback credential cannot borrow another child, owner, thread, cat, or source', async (t) => {
  const f = await fixture(t);
  for (const [owner, cat, thread, source] of [
    ['owner', 'member', 'game-thread', f.originalMessageId],
    ['foreign-owner', 'member', 'game-thread', f.originalMessageId],
    ['owner', 'foreign-cat', 'game-thread', f.originalMessageId],
    ['owner', 'member', 'foreign-thread', f.originalMessageId],
    ['owner', 'member', 'game-thread', 'foreign-source'],
  ]) {
    const credentials = await f.registry.create(
      owner,
      createCatId(cat),
      thread,
      undefined,
      undefined,
      f.policy,
      source,
    );
    const response = await f.request(credentials);
    assert.equal(response.statusCode, 409, response.body);
  }
  assert.equal(f.entered(), 0);
});

test('malformed or expanded persisted member leases fail closed', () => {
  for (const memberSession of [
    null,
    {},
    { sessionId: 'grant', generation: 0, executionId: 'event' },
    { sessionId: 'grant', generation: 1, executionId: ' ' },
    { sessionId: 'grant', generation: 1, executionId: 'event', ownerApproved: true },
  ]) {
    assert.throws(
      () =>
        parseToolExecutionPolicy(
          JSON.stringify({
            mode: 'plugin_native',
            pluginInstanceId: 'installed',
            contributionId: 'player-tools',
            memberSession,
          }),
        ),
      /member native policy/,
    );
  }
});
