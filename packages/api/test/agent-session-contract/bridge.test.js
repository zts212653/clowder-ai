import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, deferred, fixture, options, session, turn } from './fake-session-provider.js';

function assertFailure(messages, code, error = code) {
  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, code);
  assert.equal(messages[0].error, error);
  assert.equal(messages[1].errorCode, code);
}

test('constructor is inert; missing options/identity fail before resolver or provider', async () => {
  let resolutions = 0;
  const { bridge, provider } = fixture({
    resolveHostSession: (opts) => {
      assert.ok(opts);
      resolutions++;
      return { sessionId: 'host' };
    },
  });
  assert.equal(resolutions, 0);
  assert.equal(typeof bridge.invoke, 'function');
  assert.equal(typeof bridge.invokeWithContinuityPreflight, 'function');
  const preflight = { settle: () => assert.fail('must not settle') };
  assertFailure(await collect(bridge.invoke('x')), 'host_session_unavailable');
  assertFailure(await collect(bridge.invokeWithContinuityPreflight(preflight)), 'host_session_unavailable');
  assertFailure(await collect(bridge.invoke('x', {})), 'invocation_id_missing');
  assertFailure(await collect(bridge.invokeWithContinuityPreflight(preflight, {})), 'invocation_id_missing');
  assert.equal(resolutions, 0);
  for (const calls of Object.values(provider.calls)) assert.equal(calls.length, 0);
});

test('capabilities vary by real session after open; frozen works for either capability', async () => {
  const { bridge, provider } = fixture();
  provider.supportFor = (id) => {
    assert.ok(provider.calls.open.some(({ input }) => input.sessionId === id));
    return { ...provider.support, continuityEvidence: id === 'hot-capable' ? 'pre_send' : 'none' };
  };
  let settled = 0;
  const preflight = {
    settle: async () => {
      settled++;
      return { prompt: 'settled', promptGenerationId: 'g' };
    },
  };
  assertFailure(
    await collect(bridge.invokeWithContinuityPreflight(preflight, options())),
    'continuity_preflight_unsupported',
  );
  assert.equal(provider.calls.start.length, 0);
  assert.equal(settled, 0);
  await collect(bridge.invokeWithContinuityPreflight(preflight, options({ hostId: 'hot-capable' })));
  assert.equal(settled, 1);
  await collect(bridge.invoke('frozen-none', options()));
  await collect(bridge.invoke('frozen-pre-send', options({ hostId: 'hot-capable' })));
  assert.deepEqual(
    provider.calls.start.slice(1).map(({ input }) => input.prompt),
    [
      { kind: 'frozen', text: 'frozen-none' },
      { kind: 'frozen', text: 'frozen-pre-send' },
    ],
  );
});

test('deferred settle gates fake-backend prompt capture; replaced targets only the new binding', async () => {
  const { bridge, provider } = fixture();
  provider.support.continuityEvidence = 'pre_send';
  provider.evidence = { kind: 'replaced', requestedRuntimeSessionId: 'old', runtimeSessionId: 'new' };
  const entered = deferred();
  const release = deferred();
  const run = collect(
    bridge.invokeWithContinuityPreflight(
      {
        settle: async (facts) => {
          assert.equal(facts.evidence, provider.evidence);
          assert.deepEqual(provider.bytes, []);
          entered.resolve();
          await release.promise;
          return { prompt: 'new-session-prompt', promptGenerationId: 'generation-new' };
        },
      },
      options({ sessionId: 'old' }),
    ),
  );
  await entered.promise;
  assert.deepEqual(provider.bytes, []);
  release.resolve();
  await run;
  assert.deepEqual(provider.bytes, [{ id: 'new', text: 'new-session-prompt' }]);
});

test('failure before verdict never settles or hands prompt to the fake backend', async () => {
  const { bridge, provider } = fixture();
  provider.support.continuityEvidence = 'pre_send';
  provider.beforeVerdictError = new Error('transport failed');
  const messages = await collect(
    bridge.invokeWithContinuityPreflight({ settle: () => assert.fail('settled') }, options()),
  );
  assertFailure(messages, 'session_contract_failed', 'transport failed');
  assert.deepEqual(provider.bytes, []);
});

test('buffered compactions reach Host once across turns; a second settle is forwarded without interference', async () => {
  const { bridge, provider } = fixture();
  provider.support.continuityEvidence = 'pre_send';
  const observation = { eventId: 'compaction', runtimeSessionId: 'native', evidenceRef: 'wire/1' };
  provider.bufferedCompactions.push(observation);
  const facts = [];
  const preflight = {
    settle: async (input) => {
      facts.push(input);
      return { prompt: 'x', promptGenerationId: 'g' };
    },
  };
  await collect(bridge.invokeWithContinuityPreflight(preflight, options()));
  await collect(bridge.invokeWithContinuityPreflight(preflight, options()));
  assert.deepEqual(
    facts.map((f) => f.compactions),
    [[observation], []],
  );
  provider.secondVerdict = true;
  await collect(bridge.invokeWithContinuityPreflight(preflight, options()));
  assert.equal(facts.length, 4);
  assert.equal(facts[2], facts[3]);
});

test('compaction callback is awaited per event, warns on failure, and emits no message', async () => {
  const entered = deferred();
  const unblock = deferred();
  const observed = [];
  const { bridge, provider, warnings } = fixture({
    onCompactionObserved: async (observation, ctx) => {
      observed.push({ observation, ctx });
      entered.resolve();
      await unblock.promise;
      throw new Error('callback failed');
    },
  });
  const observation = { eventId: 'edge', runtimeSessionId: 'native', evidenceRef: 'wire' };
  provider.events = [
    session('compaction_observed', { observation }),
    turn('output', { text: 'after', textMode: 'append' }),
    turn('done', { outcome: 'completed' }),
  ];
  const iterator = bridge.invoke('x', options())[Symbol.asyncIterator]();
  let arrived = false;
  const next = iterator.next().then((result) => {
    arrived = true;
    return result;
  });
  await entered.promise;
  assert.equal(arrived, false);
  unblock.resolve();
  assert.equal((await next).value.content, 'after');
  assert.deepEqual(
    (await collect(iterator)).map((m) => m.type),
    ['done'],
  );
  assert.deepEqual(observed, [{ observation, ctx: { sessionId: 'host' } }]);
  assert.equal(warnings.length, 1);
  const absent = fixture();
  absent.provider.events = provider.events;
  assert.deepEqual(
    (await collect(absent.bridge.invoke('x', options()))).map((m) => m.type),
    ['text', 'done'],
  );
});

for (const code of ['busy', 'session_unavailable', 'failed']) {
  for (const reason of [undefined, 'specific failure'])
    test(`start failure ${code}/${reason} preserves code and session`, async () => {
      const { bridge, provider } = fixture();
      provider.startResult = { ok: false, code, ...(reason ? { reason } : {}) };
      assertFailure(await collect(bridge.invoke('x', options())), code, reason ?? code);
      assert.equal(provider.calls.cancel.length, 0);
      assert.equal(provider.calls.release.length, 0);
      provider.startResult = undefined;
      await collect(bridge.invoke('retry', options()));
      assert.equal(provider.calls.open.length, 1);
    });
}

for (const outcome of ['completed', 'cancelled', 'failed']) {
  for (const errorCode of [undefined, 'native-code'])
    test(`terminal ${outcome}/${errorCode} occurs exactly once`, async () => {
      const { bridge, provider } = fixture();
      provider.events = [
        turn('done', { outcome, errorCode }),
        turn('output', { text: 'late', textMode: 'append' }),
        turn('done', { outcome: 'failed' }),
      ];
      const messages = await collect(bridge.invoke('x', options()));
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'done');
      assert.equal(messages[0].errorCode, outcome === 'completed' ? undefined : (errorCode ?? outcome));
      if (outcome === 'completed') assert.equal(Object.hasOwn(messages[0], 'errorCode'), false);
    });
}

test('EOF without done supplies a terminal errorCode', async () => {
  const { bridge, provider } = fixture();
  provider.events = [turn('status', { phase: 'working' })];
  const messages = await collect(bridge.invoke('x', options()));
  assert.deepEqual(
    messages.map((m) => m.type),
    ['status', 'done'],
  );
  assert.equal(messages[1].errorCode, 'provider_stream_ended_without_done');
});

test('allowlisted DTOs, resume once, default fields, credentials are not logged', async () => {
  const { bridge, provider, logs, warnings } = fixture({ resolveMcpServers: () => [{ name: 'tools', opaque: true }] });
  const callbackEnv = { CAT_CAFE_CALLBACK_TOKEN: 'secret' };
  const toolExecutionPolicy = { mode: 'read_only', replayDeniedToolNames: ['write'] };
  const requiredTools = ['tools::read'];
  const hostOnly = { runtimeInteractionPort: {}, agentCarrierSessionFactory: () => {}, spawnCliOverride: () => {} };
  await collect(
    bridge.invoke(
      'x',
      options({
        ...hostOnly,
        callbackEnv,
        toolExecutionPolicy,
        requiredTools,
        systemPrompt: 'instructions',
        workingDirectory: '/project',
        sessionId: 'old',
        requireExactResume: true,
      }),
    ),
  );
  assert.deepEqual(provider.calls.open[0].input, {
    sessionId: 'host',
    instructions: 'instructions',
    cwd: '/project',
    resume: { nativeSessionId: 'old', onUnavailable: 'start_new' },
  });
  const input = provider.calls.start[0].input;
  assert.deepEqual(Object.keys(input).sort(), ['invocation', 'prompt']);
  assert.deepEqual(input.invocation, {
    invocationId: 'inv',
    callbackEnv,
    toolExecutionPolicy,
    requiredTools,
    mcpServers: [{ name: 'tools', opaque: true }],
  });
  assert.equal(input.invocation.callbackEnv, callbackEnv);
  assert.equal(input.invocation.toolExecutionPolicy, toolExecutionPolicy);
  assert.equal(input.invocation.requiredTools, requiredTools);
  assert.equal(JSON.stringify({ logs, warnings }).includes('secret'), false);
  await collect(bridge.invoke('next', options({ sessionId: 'different' })));
  assert.equal(provider.calls.open.length, 1);
  const defaults = fixture();
  const messages = await collect(defaults.bridge.invoke('x', options()));
  assert.deepEqual(defaults.provider.calls.open[0].input, { sessionId: 'host', instructions: '', cwd: process.cwd() });
  assert.deepEqual(defaults.provider.calls.start[0].input.invocation.callbackEnv, {});
  assert.deepEqual(Object.keys(defaults.provider.calls.start[0].input.invocation).sort(), [
    'callbackEnv',
    'invocationId',
    'mcpServers',
  ]);
  assert.equal(messages[0].metadata.provider, 'session-contract');
  assert.equal(messages[0].metadata.model, 'unknown');
});

test('pending native binding projects session_init, preserves frozen prompt, and persists for reuse', async () => {
  const { bridge, provider } = fixture();
  provider.binding = { state: 'pending_first_input' };
  provider.events = [
    session('native_bound', { nativeSessionId: 'late-native' }),
    turn('done', { outcome: 'completed' }),
  ];
  const first = await collect(bridge.invoke('frozen', options()));
  assert.deepEqual(provider.calls.start[0].input.prompt, { kind: 'frozen', text: 'frozen' });
  assert.equal(first[0].type, 'session_init');
  assert.equal(first[0].sessionId, 'late-native');
  assert.equal(first[0].metadata.sessionId, 'late-native');
  provider.events = [turn('done', { outcome: 'completed' })];
  const second = await collect(bridge.invoke('next', options()));
  assert.equal(second[0].metadata.sessionId, 'late-native');
  assert.equal(provider.calls.open.length, 1);
});

test('simultaneous first calls share open; active turn is busy without second start', async () => {
  const { bridge, provider } = fixture();
  provider.openGate = deferred();
  const settled = deferred();
  provider.support.continuityEvidence = 'pre_send';
  const first = collect(
    bridge.invokeWithContinuityPreflight(
      {
        settle: async () => {
          await settled.promise;
          return { prompt: 'x', promptGenerationId: 'g' };
        },
      },
      options(),
    ),
  );
  const second = collect(bridge.invoke('second', options({ invocationId: 'other' })));
  await Promise.resolve();
  provider.openGate.resolve();
  assertFailure(await second, 'session_busy');
  assert.equal(provider.calls.open.length, 1);
  assert.equal(provider.calls.start.length, 1);
  settled.resolve();
  await first;
});

for (const throws of [false, true])
  test(`failed open is retried (throw=${throws})`, async () => {
    const { bridge, provider } = fixture();
    if (throws) provider.openError = new Error('open failed');
    else provider.openResult = { ok: false, code: 'resume_unavailable', reason: 'open failed' };
    const messages = await collect(bridge.invoke('x', options()));
    assertFailure(messages, throws ? 'session_contract_failed' : 'resume_unavailable', 'open failed');
    assert.equal(provider.calls.start.length, 0);
    await bridge.releaseAll('failed-open');
    assert.equal(provider.calls.release.length, 0);
    provider.openError = undefined;
    provider.openResult = undefined;
    await collect(bridge.invoke('retry', options()));
    assert.equal(provider.calls.open.length, 2);
  });

test('release once per session, repeated/concurrent calls are inert, later invocation reopens', async () => {
  const { bridge, provider } = fixture();
  await collect(bridge.invoke('a', options()));
  await collect(bridge.invoke('b', options({ hostId: 'second' })));
  await Promise.all([bridge.releaseAll('removed'), bridge.releaseAll('removed')]);
  assert.deepEqual(provider.calls.release, [
    { id: 'host', reason: 'removed' },
    { id: 'second', reason: 'removed' },
  ]);
  await collect(bridge.invoke('again', options()));
  assert.equal(provider.calls.open.length, 3);
  await bridge.releaseAll('again');
  assert.equal(provider.calls.release.length, 3);
});

for (const throws of [false, true])
  test(`release failure warns without throwing (throw=${throws})`, async () => {
    const { bridge, provider, warnings } = fixture();
    await collect(bridge.invoke('a', options()));
    if (throws) provider.releaseError = new Error('release failed');
    else provider.releaseResult = { ok: false, code: 'failed', reason: 'release failed' };
    await bridge.releaseAll('removed');
    await bridge.releaseAll('removed');
    assert.equal(warnings.length, 1);
    assert.equal(provider.calls.release.length, 1);
  });
