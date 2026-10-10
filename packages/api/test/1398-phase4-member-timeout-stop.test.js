// F117 KD-22 (Phase J, J4): when a member's output timeout fires it is stopped the way Stop stops it,
// with reason `timeout`, and only that member: its siblings in the same turn run on. The stop goes
// through the Queue's slot, keyed by the parent execution id, so a timer left over from an earlier
// execution never stops the one that took the slot after it. A timed-out member failed — its
// response, its turn execution and the Queue's aggregate say so; nobody cancelled it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Cold invocation preparation can exceed 1s under concurrent build/test load.
// Leave startup headroom without changing the production timer contract.
const MEMBER_TIMEOUT_MS = 2000;
process.env.CLI_TIMEOUT_MS = String(MEMBER_TIMEOUT_MS);

const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { A2AAgentService } = await import('../dist/domains/cats/services/agents/providers/A2AAgentService.js');
const { AntigravityAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { createMockBridge } = await import('./antigravity-agent-service-test-helpers.js');
const { createMemberTimeoutStop, MEMBER_TIMEOUT_REASON } = await import(
  '../dist/domains/cats/services/agents/invocation/member-output-timeout.js'
);
const { resolveResponseTerminal } = await import('../dist/domains/cats/services/agents/routing/response-terminal.js');
const { classifyRoutingDispatchFailure } = await import(
  '../dist/domains/routing-context/RoutingDispatchSignalContract.js'
);
const { isCliStartupTimeoutError } = await import('../dist/domains/cats/services/agents/invocation/invoke-helpers.js');

const quietLog = { info() {} };

/** A member that sends a heartbeat and then never produces output until it is stopped. */
function silentService(catId) {
  return {
    async *invoke(_prompt, options) {
      yield { type: 'status', catId, content: 'still thinking', timestamp: Date.now() };
      await new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', resolve, { once: true });
      });
    },
  };
}

/** A member that answers after `delayMs`, longer than CLI_TIMEOUT_MS would allow in silence. */
function answeringService(catId, delayMs) {
  return {
    async *invoke() {
      for (let at = 0; at < delayMs; at += 40) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: 'text', catId, content: '.', timestamp: Date.now() };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function turnExecutionStore() {
  const records = new Map();
  return {
    records,
    async createRunning(input) {
      const record = { ...input, status: 'running' };
      records.set(input.invocationId, record);
      return { outcome: 'created', record };
    },
    async transitionTerminal(invocationId, terminal) {
      const record = { ...records.get(invocationId), ...terminal };
      records.set(invocationId, record);
      return { outcome: 'transitioned', record };
    },
    async get(invocationId) {
      return records.get(invocationId) ?? null;
    },
    async bindCoveredMessageIds() {
      return { outcome: 'bound' };
    },
  };
}

function routeDeps(services, turnStore) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    toolEventLog: { append: async () => {}, updateSummary: async () => {} },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `child-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
      },
      turnExecutionStore: turnStore,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

/** A Queue execution: one slot per target under the parent execution id, routed with the stop hook. */
async function dispatch(route, targets, services, { canonical = false, onTrackerReady } = {}) {
  const tracker = new InvocationTracker();
  const executionId = 'parent-exec-1';
  tracker.startAll('t1', targets, 'user1', executionId);
  const turnStore = turnExecutionStore();
  const events = [];
  const deps = routeDeps(services, turnStore);
  const store = canonical ? new MessageStore() : undefined;
  if (store) deps.messageStore = store;
  const responses = new Map();
  onTrackerReady?.(tracker);
  for await (const event of route(deps, targets, 'msg', 'user1', 't1', {
    ...(store
      ? {
          onLifecycleInvocationStarted: async ({ invocationId, catId, startedAt }) => {
            const response = store.append({
              from: { kind: 'agent', catId },
              userId: 'user1',
              threadId: 't1',
              content: '',
              mentions: [],
              timestamp: startedAt,
              lifecycle: {
                kind: 'response',
                orderKey: `${startedAt}:${invocationId}`,
                invocationId,
                targetId: catId,
                inputEntryIds: [],
                inputMessageIds: [],
                status: 'processing',
                startedAt,
              },
            });
            responses.set(catId, response.id);
            return {
              responseMessageId: response.id,
              priorFrontierMessageId: null,
              activeRun: {
                threadId: 't1',
                targetId: catId,
                invocationId,
                responseMessageId: response.id,
                inputEntryIds: [],
                inputMessageIds: [],
                privateInputEntryIds: [],
                startedAt,
              },
            };
          },
        }
      : {}),
    signalForCat: (catId) => tracker.getController('t1', catId)?.signal,
    parentInvocationId: executionId,
    stopMember: createMemberTimeoutStop({
      invocationTracker: tracker,
      threadId: 't1',
      ownerUserId: 'user1',
      log: quietLog,
    }),
  })) {
    events.push(event);
  }
  const terminalOf = (catId) => [...turnStore.records.values()].find((record) => record.catId === catId);
  return { tracker, events, terminalOf, store, responses };
}

function assertTimedOutMember(result, catId) {
  assert.equal(result.tracker.isTimedOut('t1', catId), true, `${catId} was stopped with reason timeout`);
  const failure = result.events.find((event) => event.type === 'error' && event.catId === catId);
  assert.ok(failure, `${catId}'s route reports the timeout`);
  assert.match(failure.error, /响应超时/);
  assert.ok(
    failure.metadata.timeoutDiagnostics.silenceDurationMs >= MEMBER_TIMEOUT_MS,
    'diagnostics kept from before the stop',
  );
  // Like a provider failure, the member ends with a done that names why, after its failure: the
  // Queue settles the entry failed from it instead of throwing and broadcasting a second error row.
  const events = result.events.filter((event) => event.catId === catId);
  const done = events.findLast((event) => event.type === 'done');
  assert.ok(done, `${catId}'s route ends it with a done`);
  assert.equal(done.errorCode, MEMBER_TIMEOUT_REASON, 'the done names the timeout');
  assert.ok(events.indexOf(failure) < events.indexOf(done), 'the failure is reported before the done');
  const terminal = result.terminalOf(catId);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.terminalReason, MEMBER_TIMEOUT_REASON);
  assert.equal(terminal.parentInvocationId, 'parent-exec-1', 'the timer keyed the stop by the parent execution');
  assert.notEqual(terminal.invocationId, terminal.parentInvocationId, 'while the member ran as its own child turn');
}

function assertFinishedMember(result, catId) {
  assert.equal(result.tracker.getSlotState('t1', catId), 'active', `${catId} was not stopped`);
  assert.equal(result.tracker.getController('t1', catId).signal.aborted, false);
  assert.equal(
    result.events.some((event) => event.type === 'error' && event.catId === catId),
    false,
  );
  assert.equal(result.terminalOf(catId).status, 'succeeded');
}

describe('F117 J4: a timed-out member is stopped like Stop, alone', () => {
  it('G1: the unified timeout aborts only the A2A member fetch, while its producing sibling finishes', async () => {
    let remoteWaitAborted = false;
    const remoteService = new A2AAgentService({
      catId: 'opus',
      config: { url: 'http://mock.local', timeoutMs: 10 },
      fetchFn: async (_url, options) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            remoteWaitAborted = true;
            reject(new Error('local wait aborted'));
          };
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        }),
    });
    const result = await dispatch(routeParallel, ['opus', 'codex'], {
      opus: remoteService,
      codex: answeringService('codex', MEMBER_TIMEOUT_MS + 600),
    });
    assert.equal(remoteWaitAborted, true);
    assertTimedOutMember(result, 'opus');
    assertFinishedMember(result, 'codex');
    assert.match(JSON.stringify(result.events), /远端任务是否已停止尚未确认/);
  });

  it('parallel: stops the silent member and lets its sibling finish', async () => {
    const result = await dispatch(routeParallel, ['opus', 'codex'], {
      opus: silentService('opus'),
      codex: answeringService('codex', MEMBER_TIMEOUT_MS + 600),
    });
    assertTimedOutMember(result, 'opus');
    assertFinishedMember(result, 'codex');
    const opusEvents = result.events.filter((event) => event.catId === 'opus').map((event) => event.type);
    assert.ok(opusEvents.indexOf('error') < opusEvents.lastIndexOf('done'), 'the failure is reported before its done');
  });

  it('serial: stops the silent member, then runs the next one', async () => {
    const result = await dispatch(routeSerial, ['opus', 'codex'], {
      opus: silentService('opus'),
      codex: answeringService('codex', 600),
    });
    assertTimedOutMember(result, 'opus');
    assertFinishedMember(result, 'codex');
  });
});

describe('G1: remote cancellation survives route settlement and canonical readback', () => {
  it('normal remote completion carries no cancellation notice or diagnostics', async () => {
    const service = new A2AAgentService({
      catId: 'opus',
      config: { url: 'http://mock.local' },
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'remote',
          result: {
            id: 'remote',
            status: 'completed',
            artifacts: [{ parts: [{ type: 'text', text: 'remote answer' }] }],
          },
        }),
      }),
    });
    const result = await dispatch(
      routeParallel,
      ['opus', 'codex'],
      {
        opus: service,
        codex: answeringService('codex', 100),
      },
      { canonical: true },
    );
    const reply = result.store.getById(result.responses.get('opus'));
    assert.equal(reply.lifecycle.status, 'completed');
    assert.equal(reply.content, 'remote answer');
    assert.equal(reply.metadata?.cancellationDiagnostics, undefined);
  });
  for (const [routeName, route] of [
    ['parallel', routeParallel],
    ['serial', routeSerial],
  ]) {
    for (const kind of ['a2a_task', 'antigravity_cascade']) {
      for (const reason of ['timeout', 'user_cancel']) {
        it(`${routeName} ${kind} ${reason}: same response retains uncertainty, no second error bubble`, async () => {
          let observedSignal;
          let manualStop;
          const waitForAbort = (signal) =>
            new Promise((_resolve, reject) => {
              observedSignal = signal;
              if (reason === 'user_cancel') setTimeout(() => manualStop(), 50);
              if (signal.aborted) reject(new Error('aborted'));
              else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
          let service;
          if (kind === 'a2a_task') {
            service = new A2AAgentService({
              catId: 'opus',
              config: { url: 'http://mock.local' },
              fetchFn: (_url, options) => waitForAbort(options.signal),
            });
          } else {
            const bridge = createMockBridge();
            bridge.pollForSteps = async function* (_cascade, _steps, _timeout, _limit, signal) {
              yield {
                steps: [
                  {
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    status: 'CORTEX_STEP_STATUS_RUNNING',
                    plannerResponse: { response: 'partial remote output' },
                  },
                ],
                cursor: {
                  baselineStepCount: 0,
                  lastDeliveredStepCount: 1,
                  terminalSeen: false,
                  lastActivityAt: Date.now(),
                },
              };
              await waitForAbort(signal);
            };
            service = new AntigravityAgentService({ catId: 'opus', model: 'gemini-3.1-pro', bridge });
          }
          const result = await dispatch(
            route,
            ['opus', 'codex'],
            {
              opus: service,
              codex: answeringService('codex', MEMBER_TIMEOUT_MS + 400),
            },
            {
              canonical: true,
              onTrackerReady: (tracker) => {
                manualStop = () => tracker.cancel('t1', 'opus', 'user1', 'user_cancel');
              },
            },
          );
          assert.equal(observedSignal?.aborted, true, 'the exact dispatched remote wait was cancelled');
          const reply = result.store.getById(result.responses.get('opus'));
          assert.equal(reply.lifecycle.status, reason === 'timeout' ? 'failed' : 'canceled');
          assert.equal(reply.lifecycle.reason, reason);
          assert.match(reply.content, /远端任务是否已停止尚未确认/);
          if (kind === 'antigravity_cascade') assert.match(reply.content, /partial remote output/);
          assert.equal(reply.metadata.cancellationDiagnostics.localWaitCancelled, true);
          assert.equal(reply.metadata.cancellationDiagnostics.remoteTermination, 'unconfirmed');
          assert.equal(reply.metadata.cancellationDiagnostics.remoteExecution.kind, kind);
          assert.ok(reply.metadata.cancellationDiagnostics.remoteExecution.id);
          const done = result.events.findLast((event) => event.type === 'done' && event.catId === 'opus');
          assert.equal(done.messageId, reply.id);
          assert.equal(done.content, reply.content, 'live terminal and cold readback use the same body');
          assert.deepEqual(done.metadata.cancellationDiagnostics, reply.metadata.cancellationDiagnostics);
          const history = result.store.getByThread('t1');
          assert.equal(
            history.filter((message) => message.from.kind === 'system' && message.from.service === 'agent-error')
              .length,
            0,
            JSON.stringify(history.map((message) => ({ from: message.from, content: message.content }))),
          );
          assert.equal(
            history.filter((message) => message.from.kind === 'agent' && message.from.catId === 'opus').length,
            1,
          );
          assert.equal(result.store.getById(result.responses.get('codex')).lifecycle.status, 'completed');
          assert.equal(
            result.store.getById(result.responses.get('codex')).metadata?.cancellationDiagnostics,
            undefined,
          );
          if (reason === 'timeout') assertTimedOutMember(result, 'opus');
          assertFinishedMember(result, 'codex');
        });
      }
    }
  }
});

describe('F117 J4: the Queue stop for a member timeout', () => {
  it('stops only the execution that armed the timer, never the one that took the slot after it', () => {
    const tracker = new InvocationTracker();
    const earlier = tracker.start('t1', 'opus', 'user1', ['opus'], 'exec-earlier');
    tracker.complete('t1', 'opus', earlier);
    const current = tracker.start('t1', 'opus', 'user1', ['opus'], 'exec-current');
    const stop = createMemberTimeoutStop({
      invocationTracker: tracker,
      threadId: 't1',
      ownerUserId: 'user1',
      log: quietLog,
    });

    assert.equal(stop('opus', 'exec-earlier'), false);
    assert.equal(current.signal.aborted, false, 'a leftover timer leaves the new execution alone');

    assert.equal(stop('opus', 'exec-current'), true);
    assert.equal(current.signal.reason, MEMBER_TIMEOUT_REASON);
    assert.equal(tracker.isTimedOut('t1', 'opus'), true);
  });

  it('counts a timed-out member as failed, not as cancelled by the user', () => {
    const timedOut = new InvocationTracker();
    timedOut.start('t1', 'opus', 'user1', ['opus'], 'exec-1');
    createMemberTimeoutStop({ invocationTracker: timedOut, threadId: 't1', ownerUserId: 'user1', log: quietLog })(
      'opus',
      'exec-1',
    );
    assert.equal(timedOut.resolveFinalStatus('t1', ['opus'], { aborted: false }), 'succeeded', 'outcomes decide');

    const stopped = new InvocationTracker();
    stopped.start('t1', 'opus', 'user1', ['opus'], 'exec-1');
    stopped.cancel('t1', 'opus', 'user1', 'user_cancel');
    assert.equal(stopped.isTimedOut('t1', 'opus'), false);
    assert.equal(stopped.resolveFinalStatus('t1', ['opus'], { aborted: false }), 'canceled_by_user');
  });
});

describe('F117 J4: how a stopped member ends', () => {
  it('a timeout is a failure with reason timeout; a Stop cancels; other stops interrupt', () => {
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'timeout', failed: false }), {
      status: 'failed',
      reason: 'timeout',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'user_cancel', failed: false }), {
      status: 'canceled',
      reason: 'user_cancel',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: true, abortReason: 'preempted', failed: true }), {
      status: 'interrupted',
      reason: 'preempted',
    });
    assert.deepEqual(resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: true }), {
      status: 'failed',
      reason: 'provider_error',
    });
    assert.deepEqual(
      resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: false, outputCommitRejected: true }),
      { status: 'interrupted', reason: 'output_commit_rejected' },
    );
    assert.deepEqual(resolveResponseTerminal({ aborted: false, abortReason: undefined, failed: false }), {
      status: 'completed',
    });
  });

  it('routing keeps a member timeout local to its failed response', () => {
    assert.equal(classifyRoutingDispatchFailure({ terminalReason: 'timeout' }), undefined);
  });

  it('keeps the session-resume retry for a CLI that never came up, not for silence after it did', () => {
    assert.equal(isCliStartupTimeoutError('布偶猫 CLI 响应超时 (30s, 未收到首帧)'), true);
    assert.equal(isCliStartupTimeoutError('布偶猫 CLI 响应超时 (1800s)'), false);
  });
});
