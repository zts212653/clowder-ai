import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter, type AgentRouterOptions } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import type { RouteExecutionOptions } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import {
  createScopedMemberRouting,
  type ScopedMemberRouteInput,
} from '../src/domains/cats/services/agents/routing/scoped-member-routing.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

async function drain(stream: AsyncIterable<AgentMessage>) {
  for await (const _event of stream) {
    /* consume */
  }
}

function fixture() {
  const agents = new AgentRegistry(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'Protected member');
  let homeCalls = 0,
    controlledCalls = 0;
  agents.register(createCatId('codex'), {
    async *invoke() {
      homeCalls++;
      yield { type: 'done', catId: createCatId('codex'), timestamp: Date.now() };
    },
  });
  const router = new AgentRouter({
    agentRegistry: agents,
    registry: new InvocationRegistry(),
    messageStore: messages,
    threadStore: threads,
    scopedMemberRouting: {
      resolve: async () => {
        controlledCalls++;
        throw new Error('controlled_member_not_ready');
      },
    },
  } as unknown as AgentRouterOptions);
  const options = {
    ownerAuthProvenance: 'unknown',
    onPromptMessagesExposed: async () => {},
    humanDispositionInvocationOrigin: 'direct_owner',
  } as RouteExecutionOptions;
  return { router, thread, options, homeCalls: () => homeCalls, controlledCalls: () => controlledCalls };
}

test('Queue route resolves the controlled member boundary before ordinary home preparation', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      drain(
        f.router.routeExecution(
          'owner',
          'local input',
          f.thread.id,
          'canonical-source',
          [createCatId('codex')],
          { intent: 'execute', explicit: false, promptTags: [] },
          f.options,
        ),
      ),
    /controlled_member_not_ready/,
  );
  assert.equal(f.controlledCalls(), 1);
  assert.equal(f.homeCalls(), 0);
});

test('the legacy route cannot bypass the controlled member boundary', async () => {
  const f = fixture();
  await assert.rejects(
    () => drain(f.router.route('owner', '@codex local input', f.thread.id)),
    /controlled_member_not_ready/,
  );
  assert.equal(f.controlledCalls(), 1);
  assert.equal(f.homeCalls(), 0);
});

const binding = {
  schema: 'host.member-thread.v1' as const,
  threadId: 'game-thread',
  sessionId: 'member-session',
  ownerUserId: 'owner',
  pluginInstanceId: 'installed',
  catId: 'codex',
  creationDigest: '1'.repeat(64),
};
const input: ScopedMemberRouteInput = {
  userId: 'owner',
  threadId: binding.threadId,
  sourceMessageId: 'original-source',
  targetCats: [createCatId('codex')],
  options: {},
};

test('only an authoritative absent marker permits ordinary routing', async () => {
  const absent = createScopedMemberRouting({ binding: async () => null });
  assert.deepEqual(await absent.resolve(input), { kind: 'ordinary' });
  const unavailable = createScopedMemberRouting({
    binding: async () => {
      throw new Error('storage_unavailable');
    },
  });
  await assert.rejects(() => unavailable.resolve(input), /storage_unavailable/);
  const stopped = createScopedMemberRouting({ binding: async () => binding });
  await assert.rejects(() => stopped.resolve(input), /controlled_member_not_ready/);
});

test('a protected thread rejects another owner, thread, actor, fanout, or absent source', async () => {
  let calls = 0;
  const router = createScopedMemberRouting({
    binding: async () => binding,
    invoke: async function* () {
      calls++;
    },
  });
  for (const changed of [
    { userId: 'foreign-owner' },
    { threadId: 'foreign-thread' },
    { targetCats: [createCatId('opus')] },
    { targetCats: [createCatId('codex'), createCatId('opus')] },
    { sourceMessageId: '' },
  ])
    await assert.rejects(() => router.resolve({ ...input, ...changed }), /route_scope_mismatch/);
  assert.equal(calls, 0);
});

test('a controlled route snapshots recipients and passes only canonical route hooks, without home prompt material', async () => {
  const targets = [createCatId('codex')];
  let received: ScopedMemberRouteInput | undefined;
  const router = createScopedMemberRouting({
    binding: async () => {
      targets[0] = createCatId('opus');
      return binding;
    },
    invoke: async function* (request) {
      received = request;
      yield { type: 'done', catId: createCatId('codex'), timestamp: 1 };
    },
  });
  const options = {
    signal: new AbortController().signal,
    persistedPromptMessages: [{ content: 'PRIVATE_HOME_HISTORY' }],
    liveCompanion: { text: 'PRIVATE_COMPANION_CONTEXT' },
  };
  const result = await router.resolve({ ...input, targetCats: targets, options });
  assert.equal(result.kind, 'controlled');
  if (result.kind !== 'controlled') assert.fail('expected a controlled stream');
  await drain(result.stream);
  assert.ok(received);
  assert.deepEqual(received.targetCats, ['codex']);
  assert.equal(received.options.signal, options.signal);
  assert.equal('persistedPromptMessages' in received.options, false);
  assert.equal('liveCompanion' in received.options, false);
});
