import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { nextWatcherWindowTokens } from '../dist/domains/concierge/watcher/context/watcher-budget-progress.js';
import { watcherWindow } from '../dist/domains/concierge/watcher/context/watcher-window.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { failWatcherAttempt, recoverWatcherAttempt } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { finalizeWatcherWake } from '../dist/domains/concierge/watcher/watcher-finalization.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { watcherNativePort } from '../dist/domains/concierge/watcher/watcher-native-run.js';
import { watcherWorld } from './helpers/watcher-world.js';

function fixture(tokens = 2500, failure = 'watcher_context_budget_exceeded:31000') {
  const sessions = new SessionChainStore();
  const session = sessions.create({
    userId: 'owner',
    catId: 'codex',
    threadId: 'line',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('owner', 'codex', 'line'),
    cliSessionId: 'native',
  });
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: 'wake',
    parentInvocationId: 'watcher-source:codex:source',
    userId: 'owner',
    catId: 'codex',
    threadId: 'line',
    executionKind: 'watcher',
    outputFence: 'open',
    startedAt: 100,
    causal: { watcherSourceInvocationId: 'source' },
  });
  const window = { frontier: 'original', offset: 0, messageIds: ['original'], complete: true, tokenBudget: tokens };
  sessions.compareAndSetWatcherState(session.id, 0, {
    revision: 1,
    afterSequence: 5,
    notes: 'prior notes',
    wakeInvocationId: 'wake',
    attempt: {
      invocationId: 'wake',
      sourceInvocationId: 'source',
      sourceSequence: 10,
      startedAt: 100,
      nativeTurnId: 'turn',
      phase: 'failed',
      failure,
      retries: 1,
      window: { frontier: window.frontier, offset: 0, messageIds: window.messageIds, complete: true },
    },
  });
  const events = [],
    calls = [];
  let status = 'failed',
    pruned = false;
  const client = {
    async request(method) {
      calls.push(method);
      if (method === 'thread/revert') {
        pruned = true;
        return {};
      }
      return { thread: { id: 'native', turns: pruned ? [] : [{ id: 'turn', status, items: [] }] } };
    },
  };
  const owners = {
    sessions,
    executions,
    transcript: {
      async appendDurableEvent(_session, event) {
        events.push(event);
      },
    },
  };
  return {
    session,
    owners,
    client,
    events,
    calls,
    window,
    active() {
      status = 'inProgress';
    },
    state() {
      const s = sessions.get(session.id).watcherState;
      return {
        ...s,
        ...(s.attempt ? { attempt: { ...s.attempt, window: { ...s.attempt.window, tokenBudget: tokens } } } : {}),
      };
    },
  };
}

for (const unavailable of [true, false])
  test(`local cancellation keeps its original cause when the shared counter is ${unavailable ? 'unavailable' : 'exhausted'}`, async () => {
    const f = fixture(1250, 'prior non-budget failure');
    const abort = new AbortController();
    const original = new Error('watcher_repeated_tool_budget_denial');
    abort.abort(original);
    const cause = await failWatcherAttempt(
      {
        ...f.owners,
        registry: {
          watcherToolCallCount() {
            if (unavailable) throw new Error('counter unavailable');
            return 6;
          },
        },
      },
      { session: f.session, state: { ...f.state(), rawWindowTokens: 1250 } },
      'wake',
      new Error('Codex app-server request failed'),
      abort.signal,
    );
    const expected = unavailable ? original.message : 'watcher_context_recovery_tool_budget_exhausted';
    assert.equal(cause.message, expected);
    if (unavailable) assert.equal(cause, original);
    assert.equal(f.state().attempt.failure, expected);
    const audit = f.events.find((event) => event.type === 'watcher_attempt_failure');
    assert.equal(audit.reason, expected);
    assert.equal(audit.abortReason, original.message);
    assert.equal(f.state().afterSequence, 5);
    assert.equal(f.state().consumedThrough, undefined);
  });

for (const reason of ['watcher_disabled', 'watcher_repeated_tool_budget_denial', 'watcher_deadline_exceeded'])
  test(`the owner cancellation ${reason} is not replaced by a secondary socket error`, async () => {
    const f = fixture(1250);
    const abort = new AbortController();
    abort.abort(new Error(reason));
    const cause = await failWatcherAttempt(
      { ...f.owners, registry: { watcherToolCallCount: () => 6 } },
      {
        session: f.session,
        state: { ...f.state(), rawWindowTokens: 1250 },
        boundary: {
          assertHealthy() {
            throw new Error('socket hang up');
          },
        },
      },
      'wake',
      new Error('Codex app-server request failed'),
      abort.signal,
    );
    const expected =
      reason === 'watcher_repeated_tool_budget_denial'
        ? 'watcher_context_recovery_tool_budget_exhausted'
        : reason === 'watcher_deadline_exceeded'
          ? 'watcher_context_recovery_deadline_exceeded'
          : reason;
    assert.equal(cause.message, expected);
    const audit = f.events.find((e) => e.type === 'watcher_attempt_failure');
    assert.equal(audit.abortReason, reason);
    assert.equal(audit.boundaryReason, 'socket hang up');
    assert.equal(f.state().afterSequence, 5);
  });

test('an independent transport failure after a smaller window is not a budget skip', async () => {
  const f = fixture(1250, 'prior non-budget failure');
  const original = new Error('controlled upstream failure');
  const cause = await failWatcherAttempt(
    f.owners,
    { session: f.session, state: { ...f.state(), rawWindowTokens: 1250 } },
    'wake',
    original,
    new AbortController().signal,
  );
  assert.equal(cause, original);
  const next = await recoverWatcherAttempt(f.owners, f.session, f.state(), f.client);
  assert.equal(next.afterSequence, 5);
  assert.equal(next.consumedThrough, undefined);
  assert.equal(
    f.events.some((e) => e.type === 'watcher_window_skipped'),
    false,
  );
});

test('an unavailable failed-phase store does not mask a local cancellation', async () => {
  const f = fixture();
  const abort = new AbortController();
  const original = new Error('watcher_repeated_tool_budget_denial');
  abort.abort(original);
  const cause = await failWatcherAttempt(
    {
      ...f.owners,
      sessions: {
        get() {
          throw new Error('session unavailable');
        },
      },
    },
    { session: f.session, state: f.state() },
    'wake',
    new Error('Codex app-server request failed'),
    abort.signal,
  );
  assert.equal(cause, original);
  assert.equal(f.events.find((event) => event.type === 'watcher_attempt_failure').abortReason, original.message);
  assert.equal(f.state().afterSequence, 5);
  assert.equal(f.state().consumedThrough, undefined);
});

test('a budget failure shrinks the delivered window instead of failing the source and retrying it next wake', async () => {
  const f = fixture();
  const smaller = { ...f.window, offset: 500, complete: false, tokenBudget: 1250 };
  const next = await recoverWatcherAttempt(f.owners, f.session, f.state(), f.client, true, smaller);
  assert.equal(next.rawWindowTokens, 1250);
  assert.deepEqual(next.attempt.window, smaller);
  assert.equal(f.owners.executions.get('wake').status, 'running');
  assert.equal(next.afterSequence, 5, 'a smaller, unseen slice is not acknowledged');
  assert.equal(next.attempt.nativeTurnId, undefined);
});

for (const tokens of [1250, 128])
  test(`finalizing a ${tokens}-token wake releases its reduced window for the next wake`, async () => {
    const f = fixture(tokens);
    const state = f.state();
    const pending = {
      ...state,
      revision: state.revision + 1,
      afterSequence: 10,
      rawWindowTokens: tokens,
      ...(tokens === 128 ? { skippedWindows: 1 } : {}),
      attempt: { ...state.attempt, phase: 'finalize_pending', prunedAt: 101 },
    };
    f.owners.sessions.compareAndSetWatcherState(f.session.id, state.revision, pending);
    const finalized = await finalizeWatcherWake(
      { ...f.owners, registry: new InvocationRegistry() },
      f.session,
      pending,
    );
    assert.equal(finalized.wakeInvocationId, undefined);
    assert.equal(finalized.rawWindowTokens, undefined);
    assert.equal(f.owners.executions.get('wake').status, tokens === 128 ? 'failed' : 'succeeded');
  });

test('a reduced window persists between slices of the same wake but never sizes an unrelated wake', async () => {
  const w = await watcherWorld();
  const [source] = await w.work('無關新回話。'.repeat(440));
  const state = { revision: 0, afterSequence: 0, notes: '', rawWindowTokens: 128 };
  const fresh = await watcherWindow(w.messages, source, state, '', []);
  assert.equal(fresh.tokenBudget, 2500, 'an ended wake cannot constrain a fresh source');
  const active = { ...state, rawWindowTokens: 1250, wakeInvocationId: 'same-wake' };
  const first = await watcherWindow(w.messages, source, active, '', []);
  assert.equal(first.tokenBudget, 1250);
  assert.equal(first.complete, false);
  const second = await watcherWindow(
    w.messages,
    source,
    { ...active, consumedThrough: first.frontier, messageOffset: first.offset },
    '',
    [],
  );
  assert.equal(second.tokenBudget, 1250, 'an incomplete checkpoint retains this wake’s reduced size');
  assert.ok(second.offset > first.offset || second.complete);
  const recovering = fixture(1250).state();
  assert.equal(nextWatcherWindowTokens({ ...recovering, wakeInvocationId: undefined }), 625);
});

test('an unprocessable minimum window records exact skipped originals before advancing, and survives reconstruction', async () => {
  const f = fixture(128);
  const next = await recoverWatcherAttempt(f.owners, f.session, f.state(), f.client, true, f.window);
  assert.equal(next.consumedThrough, 'original');
  assert.equal(next.afterSequence, 10);
  assert.equal(next.attempt.phase, 'finalize_pending');
  assert.equal(next.skippedWindows, 1);
  const skipped = f.events.find((e) => e.type === 'watcher_window_skipped');
  assert.deepEqual(skipped.messageIds, ['original']);
  assert.equal(skipped.sourceInvocationId, 'source');
  assert.equal(skipped.reason, 'watcher_context_budget_exceeded');
  assert.equal(f.state().consumedThrough, next.consumedThrough);
  assert.ok(f.calls.includes('thread/revert'));
});

for (const failure of ['watcher_context_budget_exceeded:31000', 'watcher_context_recovery_deadline_exceeded']) {
  test(`${failure} does not prune or acknowledge an active native turn`, async () => {
    const f = fixture(128, failure);
    f.active();
    await assert.rejects(
      recoverWatcherAttempt(f.owners, f.session, f.state(), f.client, true, f.window),
      /still_active/,
    );
    assert.equal(f.state().afterSequence, 5);
    assert.equal(f.calls.includes('thread/revert'), false);
    assert.equal(f.events.length, 0);
  });

  test(`${failure} audit failure never advances the cursor or discards the outstanding owner`, async () => {
    const f = fixture(128, failure);
    f.owners.transcript.appendDurableEvent = async (_s, event) => {
      if (event.type === 'watcher_window_skipped') throw new Error('audit unavailable');
    };
    await assert.rejects(
      recoverWatcherAttempt(f.owners, f.session, f.state(), f.client, true, f.window),
      /audit unavailable/,
    );
    assert.equal(f.state().afterSequence, 5);
    assert.equal(f.state().attempt.invocationId, 'wake');
    assert.equal(f.state().consumedThrough, undefined);
  });

  test(`${failure} cannot change an ordinary execution or a mismatched watcher`, async () => {
    const f = fixture(128, failure);
    const original = f.owners.executions.get.bind(f.owners.executions);
    f.owners.executions.get = (id) => ({ ...original(id), executionKind: 'ordinary' });
    await assert.rejects(
      recoverWatcherAttempt(f.owners, f.session, f.state(), f.client, true, f.window),
      /binding_mismatch/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.state().afterSequence, 5);
  });
}

test('an original whose header cannot fit the minimum window is audibly skipped without launching a provider', async () => {
  const w = await watcherWorld();
  const original = {
    id: '龘'.repeat(180),
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    content: 'unread original',
    timestamp: 1000,
  };
  w.messages.getById = async (id) => (id === original.id ? original : null);
  w.executions.createRunning({
    invocationId: 'unfit-source',
    parentInvocationId: 'ordinary',
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    executionKind: 'ordinary',
    outputFence: 'open',
    startedAt: 1,
  });
  await w.executions.transitionTerminal('unfit-source', {
    status: 'succeeded',
    endedAt: 1001,
    providerTeardownAt: 1001,
  });
  await w.executions.markResponseSettled('unfit-source', { kind: 'message', messageId: original.id, settledAt: 1001 });
  const source = await w.executions.get('unfit-source');
  const session = await w.sessions.getOrCreateActive({
    userId: 'watcher-owner',
    catId: 'codex',
    threadId: w.thread.id,
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('watcher-owner', 'codex', w.thread.id),
  });
  const owners = { ...w, apiUrl: 'http://127.0.0.1:3102', maySpeak: async () => false };
  const run = { session, state: { revision: 0, afterSequence: 0, notes: '' }, committed: false, prefixTokens: 0 };
  const { auth } = await watcherInvocationAuthority(owners, run, source, []);
  await w.sessions.compareAndSetWatcherState(session.id, 0, {
    revision: 1,
    afterSequence: 0,
    notes: '',
    wakeInvocationId: auth.invocationId,
    rawWindowTokens: 128,
  });
  const events = [];
  await runWatcherInvocation(
    {
      ...owners,
      transcript: {
        async appendDurableEvent(_s, event) {
          events.push(event);
        },
      },
    },
    {
      session,
      source,
      quiet: true,
      service: {
        boundedWatcherSessionCapability: () => ({ supported: true }),
        async *invoke() {
          assert.fail('an empty window must not launch a provider');
        },
      },
    },
  );
  assert.equal(w.sessions.get(session.id).watcherState.afterSequence, source.settledSequence);
  assert.deepEqual(events.find((e) => e.type === 'watcher_window_skipped').messageIds, [original.id]);
  const [wake] = await w.executions.listByParent('watcher-source:codex:unfit-source');
  assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
});

for (const large of [false, true])
  test(`the same ${large ? 'large' : 'small'} directory is fetched once across native port reconstruction`, async () => {
    const f = fixture();
    const registry = new InvocationRegistry();
    const auth = await registry.create('owner', 'codex', 'line', undefined, undefined, {
      mode: 'watcher',
      maxToolCalls: 6,
      allowedToolNames: ['cat_cafe_list_memory_matters'],
      allowedCallbackRoutes: [],
    });
    const current = f.owners.sessions.get(f.session.id).watcherState;
    f.owners.sessions.compareAndSetWatcherState(f.session.id, current.revision, {
      ...current,
      revision: current.revision + 1,
      wakeInvocationId: auth.invocationId,
      attempt: { ...current.attempt, invocationId: auth.invocationId },
    });
    let fetches = 0;
    const createPort = () =>
      watcherNativePort({
        owners: { ...f.owners, registry },
        run: { session: f.session, state: f.state() },
        bridge: {
          tools: [],
          async call(_name, _args, id) {
            fetches++;
            assert.equal(
              await registry.consumeWatcherToolCall(auth.invocationId, id, 'cat_cafe_list_memory_matters'),
              'accepted',
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    items: Array.from({ length: large ? 30 : 1 }, () => ({
                      matterId: 'matter-original',
                      revision: 7,
                      title: large ? '"\\'.repeat(100) : 'Original matter',
                      description: 'large original summary '.repeat(400),
                    })),
                  }),
                },
              ],
            };
          },
        },
        surface: { config: {} },
        instructions: '',
        signal: AbortSignal.timeout(10000),
        recovery: false,
        accepted: Promise.resolve(),
        acceptToolCalls() {},
        abort(error) {
          throw error;
        },
        recorder: {},
      });
    const args = (id) => ({
      threadId: 'native',
      turnId: 'turn',
      callId: id,
      tool: 'cat_cafe_list_memory_matters',
      arguments: { query: 'same matter', limit: 4 },
    });
    await createPort().callTool(args('first'));
    const repeated = await createPort().callTool(args('second'));
    assert.equal(fetches, 1);
    assert.match(JSON.stringify(repeated), /matter-original/);
    assert.equal(
      await registry.watcherToolCallCount(auth.invocationId),
      2,
      'cached calls still spend the shared six-call budget',
    );
    for (const [i, query] of [
      { query: 'another matter', limit: 4 },
      { query: 'same matter', cursor: 'next-page', limit: 4 },
      { query: 'same matter', limit: 5 },
    ].entries())
      await createPort().callTool({ ...args(`distinct-${i}`), arguments: query });
    assert.equal(fetches, 4, 'query, cursor and limit changes each read their own page');
    await createPort().callTool({ ...args('reordered'), arguments: { limit: 4, query: 'same matter' } });
    assert.equal(fetches, 4, 'argument key order does not create another physical read');
    assert.equal(await registry.watcherToolCallCount(auth.invocationId), 6);
  });

for (const reason of ['watcher_deadline_exceeded', 'watcher_repeated_tool_budget_denial', 'watcher_disabled'])
  test(`a first real context refusal concurrent with ${reason} remains recoverable without weakening controls`, async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort(new Error(reason));
    const budget = new Error('watcher_context_budget_exceeded:29441');
    const cause = await failWatcherAttempt(
      { ...f.owners, registry: { watcherToolCallCount: () => 6 } },
      {
        session: f.session,
        state: f.state(),
        boundary: {
          assertHealthy() {
            throw budget;
          },
        },
      },
      'wake',
      new Error('generic native failure'),
      abort.signal,
    );
    assert.equal(cause, reason === 'watcher_disabled' ? abort.signal.reason : budget);
    const audit = f.events.find((e) => e.type === 'watcher_attempt_failure');
    assert.equal(audit.abortReason, reason);
    assert.equal(audit.boundaryReason, budget.message);
    assert.equal(f.state().afterSequence, 5);
  });
