import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  type InvocationDeps,
  type InvocationParams,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../src/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../src/domains/cats/services/stores/ports/ContextEpochStore.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'scoped-member-invocation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catId = createCatId('codex');
  const config = catRegistry.tryGet(catId)?.config;
  assert.ok(config);
  const captured: { prompt: string; options?: AgentServiceOptions }[] = [];
  const epochStore = new InMemoryContextEpochStore();
  let pendingDecisionReads = 0;
  let currentChecks = 0,
    revoked = false,
    revokeDuringSessionRead = false,
    previousSession: string | undefined;
  const native = {
    server: { name: 'member_tools', command: '/usr/bin/true', args: [], env: {}, workingDirectory: directory },
    sandbox: { kind: 'scoped-member', workspaceRoot: directory },
    assertCurrent: async () => {
      currentChecks++;
      if (revoked) throw new Error('scope_revoked');
    },
  };
  const thread = {
    id: 'game-thread',
    title: 'PRIVATE_ENGINEERING_TITLE',
    titleSource: 'temporary',
    projectPath: directory,
    phase: 'PRIVATE_ENGINEERING_MISSION',
    createdBy: 'owner',
  };
  const deps = {
    registry: new InvocationRegistry(),
    sessionManager: {
      get: async () => {
        if (revokeDuringSessionRead) revoked = true;
        return previousSession;
      },
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
    },
    threadStore: { get: async () => thread },
    apiUrl: 'http://127.0.0.1:3102',
    contextEpochOwner: new ContextEpochOwner(epochStore),
    routingContextPromptProjection: { resolve: async () => 'PRIVATE_HOME_ROUTING_HINT' },
    runtimeInteractionPort: {
      pendingConversationDecisionPrompt: async () => {
        pendingDecisionReads++;
        return 'PRIVATE_ENGINEERING_DECISION';
      },
    },
  } as unknown as InvocationDeps;
  const params = {
    catId,
    userId: 'owner',
    threadId: thread.id,
    isLastCat: true,
    prompt: 'APPROVED_MEMORY_AND_LOCAL_EVENT',
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'installed',
      contributionId: 'member-tools',
      memberSession: { sessionId: 'grant', generation: 1, executionId: 'event' },
    },
    scopedMemberLaunch: native,
    executionBinding: {
      catConfig: { ...config, mcpSupport: false },
      workspace: {
        thread,
        workingDirectory: directory,
        workingProjectRoot: directory,
        threadProjectPath: directory,
        usesDefaultWorkspace: false,
      },
      projectRoot: directory,
      resolvedAccount: null,
    },
    service: {
      supportsToolExecutionPolicy: () => true,
      async *invoke(prompt: string, options?: AgentServiceOptions) {
        captured.push({ prompt, options });
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    },
  } as unknown as InvocationParams;
  const run = async (input = params) => {
    const events = [];
    for await (const event of invokeSingleCat(deps, input)) events.push(event);
    return events;
  };
  return {
    params,
    native,
    run,
    captured,
    epochStore,
    checks: () => currentChecks,
    pendingDecisionReads: () => pendingDecisionReads,
    revoke: () => {
      revoked = true;
    },
    expireDuringSessionRead: () => {
      revokeDuringSessionRead = true;
    },
    priorSession: (value: string) => {
      previousSession = value;
    },
  };
}

test('a scoped member reaches the existing invocation kernel with only its approved prompt and native port', async (t) => {
  const f = await fixture(t);
  const events = await f.run();
  assert.equal(f.captured.length, 1, JSON.stringify(events.filter((event) => event.type === 'error')));
  assert.equal(f.captured[0]?.prompt, 'APPROVED_MEMORY_AND_LOCAL_EVENT');
  assert.equal(f.captured[0]?.options?.pluginNativeLaunch?.sandbox.kind, 'scoped-member');
  assert.ok(f.checks() >= 2, 'currentness is checked before admission and immediately before provider execution');
});

test('a scoped Codex continuity handshake retains the canonical epoch owner before provider admission', async (t) => {
  const f = await fixture(t);
  const events = await f.run({
    ...f.params,
    service: {
      ...f.params.service,
      contextCapability: () => ({
        provider: 'openai',
        carrier: 'exec_json',
        reportsRuntimeWindow: true,
        authoritativeUsage: true,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: true,
        observesCompression: false,
        reason: 'same native continuity contract as the real scoped Codex carrier',
      }),
    },
  });
  assert.equal(f.captured.length, 1, JSON.stringify(events.filter((event) => event.type === 'error')));
  assert.equal(f.epochStore.get('owner::codex::game-thread')?.contextEpoch, 1);
  assert.equal(f.captured[0]?.prompt, 'APPROVED_MEMORY_AND_LOCAL_EVENT');
  assert.equal(f.pendingDecisionReads(), 0);
});

test('even an authenticated owner turn does not read unrelated pending engineering decisions', async (t) => {
  const f = await fixture(t);
  await f.run({ ...f.params, ownerAuthProvenance: 'strict' });
  assert.equal(f.pendingDecisionReads(), 0);
  assert.equal(f.captured[0]?.prompt, 'APPROVED_MEMORY_AND_LOCAL_EVENT');
});

test('a scoped native launch cannot carry ordinary home identity or a different tool policy', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.run({ ...f.params, systemPrompt: 'PRIVATE_HOME_IDENTITY' }), /scoped_member/);
  await assert.rejects(
    () => f.run({ ...f.params, toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } }),
    /scoped_member/,
  );
  await assert.rejects(
    () =>
      f.run({
        ...f.params,
        toolExecutionPolicy: { mode: 'plugin_native', pluginInstanceId: 'installed', contributionId: 'member-tools' },
      }),
    /scoped_member/,
  );
  await assert.rejects(() => f.run({ ...f.params, memoryCueOpportunitySeeds: [] }), /scoped_member/);
  assert.equal(f.captured.length, 0);
});

test('revocation after child admission still prevents the provider from executing', async (t) => {
  const f = await fixture(t);
  f.expireDuringSessionRead();
  const events = await f.run();
  assert.equal(f.captured.length, 0);
  assert.ok(f.checks() >= 2);
  assert.ok(events.some((event) => event.type === 'error'));
});

test('a scoped native turn restores approved state without resuming a previous native conversation', async (t) => {
  const f = await fixture(t);
  f.priorSession('previous-native-conversation');
  await f.run();
  assert.equal(f.captured.length, 1);
  assert.equal(f.captured[0]?.options?.sessionId, undefined);
  assert.equal(f.captured[0]?.options?.cliSessionId, undefined);
});

test('the scoped native descriptor is captured before awaited authority checks', async (t) => {
  const f = await fixture(t);
  const memberSession = { sessionId: 'grant', generation: 1, executionId: 'event' };
  f.native.assertCurrent = async () => {
    f.native.server.name = 'replacement-server';
    memberSession.generation = 2;
  };
  await f.run({
    ...f.params,
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'installed',
      contributionId: 'member-tools',
      memberSession,
    },
  });
  assert.equal(f.captured[0]?.options?.pluginNativeLaunch?.server.name, 'member_tools');
  assert.deepEqual(f.captured[0]?.options?.toolExecutionPolicy, {
    mode: 'plugin_native',
    pluginInstanceId: 'installed',
    contributionId: 'member-tools',
    memberSession: { sessionId: 'grant', generation: 1, executionId: 'event' },
  });
});

for (const error of ['CLI 异常退出 (code: 1, signal: none)', 'malformed_toolcall: model returned an invalid call']) {
  test(`a scoped provider failure remains visible with one attempt: ${error}`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const events = await f.run({
      ...f.params,
      service: {
        ...f.params.service,
        async *invoke() {
          calls++;
          yield { type: 'error' as const, catId: f.params.catId, error, timestamp: Date.now() };
          yield { type: 'done' as const, catId: f.params.catId, timestamp: Date.now() };
        },
      },
    });
    assert.equal(calls, 1);
    assert.ok(events.some((event) => event.type === 'error' && event.error === error));
    assert.equal(
      events.some((event) => event.type === 'system_info' && event.content?.includes('malformed_fallback')),
      false,
    );
  });
}

test('a revoked scoped member is rejected before the provider can execute', async (t) => {
  const f = await fixture(t);
  f.revoke();
  await assert.rejects(() => f.run(), /scope_revoked/);
  assert.equal(f.captured.length, 0);
});
