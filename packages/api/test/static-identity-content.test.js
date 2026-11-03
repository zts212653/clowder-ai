import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveInvocationCapacitySnapshot } from '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

function fixture(t, suffix, initialResume) {
  t.after(isolateAccountAuthEnvironment());
  const all = catRegistry.getAllConfigs();
  const catId = `static-content-${suffix}`;
  const config = {
    ...all.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  };
  catRegistry.register(catId, config);
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, member]) => {
      catRegistry.register(id, member);
    });
  });
  let resume = initialResume;
  let fail = false;
  let usage;
  const prompts = [];
  const service = {
    contextCapability: () => ({
      provider: 'test',
      carrier: 'test_stream',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: 'controlled static identity fixture',
    }),
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'session_init', catId, sessionId: resume ?? `native-${catId}`, timestamp: Date.now() };
      if (fail)
        yield {
          type: 'error',
          catId,
          error: 'controlled task failure',
          errorCode: 'fixture_failure',
          timestamp: Date.now(),
        };
      yield {
        type: 'done',
        catId,
        ...(fail ? { errorCode: 'fixture_failure' } : {}),
        timestamp: Date.now(),
        ...(usage ? { metadata: { provider: 'openai', model: 'fixture', usage } } : {}),
      };
    },
  };
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  deps.services = { [catId]: service };
  deps.invocationDeps.sessionManager.get = async () => resume;
  deps.invocationDeps.sessionManager.store = async (_user, _cat, _thread, id) => {
    resume = id;
  };
  deps.invocationDeps.sessionManager.delete = async () => {
    resume = undefined;
  };
  const invoke = async (body) => {
    const expectedCalls = prompts.length + 1;
    const capacitySnapshot = await resolveInvocationCapacitySnapshot({ catId, threadId: catId, service });
    await Array.fromAsync(
      invokeSingleCat(deps.invocationDeps, {
        catId,
        service,
        userId: 'owner',
        threadId: catId,
        prompt: 'one task',
        systemPrompt: body,
        isLastCat: true,
        ownerAuthProvenance: 'strict',
        capacitySnapshot,
      }),
    );
    assert.equal(prompts.length, expectedCalls, 'the actual provider boundary must be reached once');
    return prompts.at(-1);
  };
  const reload = (patch) => {
    const current = catRegistry.getAllConfigs();
    catRegistry.reset();
    Object.entries(current).forEach(([id, member]) => {
      catRegistry.register(id, id === catId ? { ...member, ...patch } : member);
    });
  };
  return {
    catId,
    config,
    prompts,
    invoke,
    reload,
    routingDeps: deps,
    setFailure: (value) => {
      fail = value;
    },
    setResume: (value) => {
      resume = value;
    },
    setUsage: (inputTokens) => {
      usage = { inputTokens, lastTurnInputTokens: inputTokens, outputTokens: 1000, contextWindowSize: 128000 };
    },
  };
}

test('unchanged static identity is omitted on warm turns despite fresh invocation credentials', async (t) => {
  const f = fixture(t, 'stable');
  assert.match(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
  assert.doesNotMatch(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
});

test('an avatar-only registry revision does not resend unchanged static identity', async (t) => {
  const f = fixture(t, 'avatar');
  await f.invoke('ROLE_BODY_A');
  f.reload({ avatar: 'new-avatar.png' });
  assert.doesNotMatch(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
});

test('changed static identity is delivered even when the registry revision is unchanged', async (t) => {
  const f = fixture(t, 'body');
  await f.invoke('ROLE_BODY_A');
  assert.match(await f.invoke('ROLE_BODY_B'), /ROLE_BODY_B/);
});

test('a failed turn cannot mark its new static identity as successfully delivered', async (t) => {
  const f = fixture(t, 'failure');
  await f.invoke('ROLE_BODY_A');
  f.reload({ displayName: 'new role name' });
  f.setFailure(true);
  assert.match(await f.invoke('ROLE_BODY_B'), /ROLE_BODY_B/);
  f.setFailure(false);
  assert.match(await f.invoke('ROLE_BODY_B'), /ROLE_BODY_B/);
});

test('a resumed native session without local identity evidence receives the current static prefix', async (t) => {
  const f = fixture(t, 'unknown', 'previous-native');
  assert.match(await f.invoke('ROLE_BODY_CURRENT'), /ROLE_BODY_CURRENT/);
});

test("a different native segment cannot inherit another segment's static identity cache", async (t) => {
  const f = fixture(t, 'segment');
  await f.invoke('ROLE_BODY_A');
  f.setResume('different-native-segment');
  assert.match(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
  assert.doesNotMatch(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
});

test('a failed post-compression turn cannot consume the required identity reinjection', async (t) => {
  const f = fixture(t, 'compression');
  f.setUsage(60000);
  await f.invoke('ROLE_BODY_A');
  f.setUsage(15000);
  assert.doesNotMatch(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
  f.setFailure(true);
  assert.match(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
  f.setFailure(false);
  assert.match(await f.invoke('ROLE_BODY_A'), /ROLE_BODY_A/);
});

test('the actual serial route reuses a successfully delivered static prefix on its next turn', async (t) => {
  const f = fixture(t, 'routed');
  f.reload({ roleDescription: 'ROUTED_ROLE_MARKER' });
  await Array.fromAsync(
    routeSerial(f.routingDeps, [f.catId], 'first task', 'owner', f.catId, { thinkingMode: 'play' }),
  );
  await Array.fromAsync(
    routeSerial(f.routingDeps, [f.catId], 'second task', 'owner', f.catId, { thinkingMode: 'play' }),
  );
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[0], /ROUTED_ROLE_MARKER/);
  assert.doesNotMatch(f.prompts[1], /ROUTED_ROLE_MARKER/);
});
