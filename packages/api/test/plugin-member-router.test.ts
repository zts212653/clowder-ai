import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationDeps } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { AgentMessage, AgentServiceOptions } from '../src/domains/cats/services/types.js';
import type { MemberCallbackIdentity } from '../src/domains/plugin/member-sessions/callback.js';
import { createMemberSessionHost } from '../src/domains/plugin/member-sessions/host.js';
import { createMemberSessionRouter } from '../src/domains/plugin/member-sessions/router.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { MemberSessionStore } from '../src/domains/plugin/member-sessions/store.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture(t: TestContext) {
  const f = memberSessionFixture();
  const directory = await mkdtemp(join(tmpdir(), 'member-router-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const turns = new InMemoryTurnExecutionStore(),
    messages = new MessageStore();
  const sessions = createPluginMemberSessions({ ...f.deps, canonicalExecution: { turns, messages } });
  const scope = f.scope(),
    host = createMemberSessionHost(sessions),
    store = new MemberSessionStore(f.deps.storage);
  const row = await f.owner(() => sessions.forInstance(scope).prepare(f.prepareInput));
  const port = host.forInstance(scope);
  const run = await port.execute({
    sessionId: row.sessionId,
    generation: row.generation,
    executionId: 'event-1',
    semanticCursor: 7,
    content: 'LOCAL_EVENT',
  });
  const sourceMessageId = run.messageId!;
  const binding = {
    schema: 'host.member-thread.v1',
    threadId: row.threadId,
    sessionId: row.sessionId,
    ownerUserId: 'owner',
    pluginInstanceId: 'installed',
    catId: 'member',
    creationDigest: 'creation',
  } as const;
  await f.deps.storage.compareAndSet('routing-threads', row.threadId, null, binding);
  const callback = new Map<string, (caller: MemberCallbackIdentity) => Promise<void>>();
  let starts = 0,
    releases = 0,
    afterClaim: (() => Promise<void>) | undefined;
  const captured: { prompt: string; options?: AgentServiceOptions }[] = [];
  const cancellation = new AbortController();
  const config = catRegistry.tryGet(createCatId('codex'))!.config;
  if (!catRegistry.has('member')) catRegistry.register('member', { ...config, id: 'member' });
  const deps = {
    registry: new InvocationRegistry(),
    turnExecutionStore: turns,
    messageStore: messages,
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
    },
    threadStore: {
      get: async () => ({
        id: row.threadId,
        projectPath: directory,
        createdBy: 'owner',
        title: 'UNRELATED_HOME_TITLE',
      }),
    },
    apiUrl: 'http://127.0.0.1:3102',
  } as unknown as InvocationDeps;
  const router = createMemberSessionRouter({
    sessions,
    store,
    executionScope: host.executionScope,
    executionSignal: host.executionSignal,
    finishExecution: host.finishExecution,
    messaging: f.deps.messaging,
    memory: f.deps.resolveMemory,
    native: async () => ({
      name: 'game',
      command: '/usr/bin/true',
      args: [],
      env: {},
      workingDirectory: directory,
      transport: 'stdio',
    }),
    invocationDeps: () => deps,
    registerCallback: (claim, assert) => {
      const remove = host.registerCallback(claim, assert);
      callback.set(claim.invocationId, assert);
      return () => {
        remove();
        callback.delete(claim.invocationId);
      };
    },
    acquire: async () => ({
      runtime: row.runtime,
      binding: {
        catConfig: { ...config, mcpSupport: false },
        projectRoot: directory,
        resolvedAccount: null,
        workspace: { workingDirectory: directory, workingProjectRoot: directory, usesDefaultWorkspace: false },
      },
      service: {
        supportsToolExecutionPolicy: () => true,
        async *invoke(prompt, options) {
          starts++;
          captured.push({ prompt, options });
          await afterClaim?.();
          yield {
            type: 'tool_use',
            catId: createCatId('member'),
            toolName: 'observe',
            toolInput: {},
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: createCatId('member'),
            content: 'LOCAL_WORLD_RECEIPT',
            timestamp: Date.now(),
          };
          yield {
            type: 'text',
            catId: createCatId('member'),
            content: '@kimi31-pro\n我看到了。',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: createCatId('member'), timestamp: Date.now() };
        },
      },
      release: async () => {
        releases++;
      },
    }),
  });
  const input = {
    userId: 'owner',
    threadId: row.threadId,
    sourceMessageId,
    targetCats: [createCatId('member')],
    options: {
      signal: cancellation.signal,
      parentInvocationId: 'queue-parent',
      ownerAuthProvenance: 'strict' as const,
      onLifecycleInvocationStarted: async (child: { invocationId: string; startedAt: number }) => {
        const response = messages.append({
          userId: 'owner',
          threadId: row.threadId,
          from: { kind: 'agent', catId: createCatId('member') },
          content: '',
          mentions: [],
          timestamp: child.startedAt,
          lifecycle: {
            kind: 'response',
            orderKey: `${child.startedAt}:${child.invocationId}`,
            invocationId: child.invocationId,
            targetId: 'member',
            inputEntryIds: ['entry'],
            inputMessageIds: [sourceMessageId],
            status: 'processing',
            startedAt: child.startedAt,
          },
        });
        return {
          responseMessageId: response.id,
          priorFrontierMessageId: null,
          activeRun: { targetId: 'member', invocationId: child.invocationId, startedAt: child.startedAt },
        };
      },
    },
  };
  const collect = async (next = input) => {
    const route = await router.resolve(next);
    assert.equal(route.kind, 'controlled');
    const events: AgentMessage[] = [];
    if (route.kind === 'controlled') for await (const event of route.stream) events.push(event);
    return events;
  };
  return {
    ...f,
    sessions,
    host,
    store,
    port,
    row,
    run,
    input,
    collect,
    messages,
    turns,
    callback,
    captured,
    starts: () => starts,
    releases: () => releases,
    afterClaim: (next: () => Promise<void>) => {
      afterClaim = next;
    },
    cancel: () => cancellation.abort('user_cancel'),
  };
}

test('one local event uses the existing child kernel, canonical response, tool history and terminal receipt', async (t) => {
  const f = await fixture(t);
  const events = await f.collect();
  assert.equal(f.starts(), 1, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.match(f.captured[0]!.prompt, /主人给我的真实名字。/);
  assert.match(f.captured[0]!.prompt, /LOCAL_EVENT/);
  assert.ok(!f.captured[0]!.prompt.includes('UNRELATED_HOME_TITLE'));
  const receipt = await f.port.execute({
    sessionId: f.row.sessionId,
    generation: 1,
    executionId: 'event-1',
    semanticCursor: 7,
    content: 'LOCAL_EVENT',
  });
  assert.equal(receipt.phase, 'succeeded');
  assert.ok(receipt.responseMessageId);
  const response = f.messages.getById(receipt.responseMessageId!);
  assert.equal(response?.lifecycle?.status, 'completed');
  assert.deepEqual(response?.mentions, [], 'game text cannot wake outside cats through ordinary mention routing');
  assert.equal(response?.toolEvents?.length, 2);
  assert.equal((await f.port.get(f.row.sessionId))?.consumedCursor, 7);
  assert.equal(f.callback.size, 0);
  assert.equal(f.releases(), 1);
  assert.equal(f.sends(), 1);
  const saved = (await f.store.get(f.row.sessionId))!.value;
  assert.throws(() => f.host.executionScope(saved, f.run), /original_admission_scope_unavailable/);
});

test('a different real source cannot adopt the pending event or start any model', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.collect({ ...f.input, sourceMessageId: 'foreign-source' }), /original_source_mismatch/);
  assert.equal(f.starts(), 0);
  assert.equal(f.releases(), 0);
});

test('revocation while the provider runs cancels only the original child and saves its receipt without advancing input', async (t) => {
  const f = await fixture(t);
  f.afterClaim(async () => {
    const invocationId = [...f.callback.keys()][0]!;
    const current = f.callback.get(invocationId)!;
    const caller = {
      userId: 'owner',
      threadId: f.row.threadId,
      catId: 'member',
      invocationId,
      originTriggerMessageId: f.run.messageId,
      toolExecutionPolicy: {
        mode: 'plugin_native' as const,
        pluginInstanceId: 'installed',
        contributionId: 'player-tools',
        memberSession: { sessionId: f.row.sessionId, generation: 1, executionId: 'event-1' },
      },
    };
    await current(caller);
    await f.owner(() => f.port.revoke(f.row.sessionId));
    f.cancel();
    await assert.rejects(current(caller), /revoked/);
    throw new Error('provider canceled');
  });
  await f.collect();
  const receipt = await f.port.getExecution({ sessionId: f.row.sessionId, generation: 1, executionId: 'event-1' });
  assert.equal(receipt?.phase, 'canceled');
  assert.equal(receipt?.messageId, f.run.messageId);
  assert.equal((await f.port.get(f.row.sessionId))?.consumedCursor, 0);
  assert.equal(f.callback.size, 0);
  assert.equal(f.releases(), 1);
  assert.equal(f.sends(), 1);
});

test('the actual Queue member signal cancels the controlled child while the shared batch remains active', async (t) => {
  const f = await fixture(t),
    member = new AbortController();
  f.afterClaim(async () => {
    member.abort('user_cancel');
    throw new Error('provider stopped');
  });
  await f.collect({ ...f.input, options: { ...f.input.options, signalForCat: () => member.signal } });
  assert.equal(f.input.options.signal.aborted, false);
  const receipt = await f.port.getExecution({ sessionId: f.row.sessionId, generation: 1, executionId: 'event-1' });
  assert.equal(receipt?.phase, 'canceled');
  assert.equal((await f.port.get(f.row.sessionId))?.consumedCursor, 0);
});

test('stop between canonical response creation and member claim saves the unstarted canceled child as an original fact', async (t) => {
  const f = await fixture(t);
  const start = f.input.options.onLifecycleInvocationStarted;
  await f.collect({
    ...f.input,
    options: {
      ...f.input.options,
      onLifecycleInvocationStarted: async (child) => {
        const response = await start(child);
        await f.owner(() => f.port.revoke(f.row.sessionId));
        f.cancel();
        return response;
      },
    },
  });
  const receipt = await f.port.getExecution({ sessionId: f.row.sessionId, generation: 1, executionId: 'event-1' });
  assert.equal(receipt?.phase, 'canceled');
  assert.equal(receipt?.messageId, f.run.messageId);
  assert.ok(receipt?.invocationId);
  assert.equal(f.starts(), 0);
  assert.equal((await f.port.get(f.row.sessionId))?.consumedCursor, 0);
});
