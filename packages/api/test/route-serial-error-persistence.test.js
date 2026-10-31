import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

for (const wake of [
  { kind: 'legacy', reason: 'carrier_missing' },
  { kind: 'action_successor', leaseId: 'lease-1', generation: 1, holderCatId: 'codex' },
]) {
  it(`${wake.kind} projection never starts a hidden corrective model invocation`, async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appended = [];
    let calls = 0;
    const deps = createMockDeps(
      {
        codex: {
          async *invoke() {
            calls++;
            yield {
              type: 'text',
              catId: 'codex',
              content: calls === 1 ? 'Hello from CLI' : 'unwanted correction',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      appended,
    );
    deps.turnCustodyProjectionService = {
      open: async () => ({ state: 'unknown_legacy', evidenceRefs: ['test:missing-carrier'] }),
      close: async () => ({
        state: 'unknown_legacy',
        shouldBlock: true,
        transitionObserved: false,
        evidenceRefs: ['test:missing-carrier'],
      }),
    };
    for await (const _ of routeSerial(deps, ['codex'], 'Hello', 'user1', 'thread1', { turnCustodyWake: wake })) void _;
    assert.equal(calls, 1);
    assert.ok(appended.some((message) => message.content === 'Hello from CLI'));
    assert.ok(appended.every((message) => !message.content.includes('unwanted correction')));
  });
}

/**
 * Verify that ACP error messages are persisted as system messages
 * so they survive F5 (page refresh) — the error badge should render
 * identically on reload as during streaming.
 *
 * Root cause: errors were appended to textContent as `[错误] ...` and
 * persisted as regular cat messages (catId set). On reload, these render
 * as normal assistant bubbles, not as red error badges. The frontend's
 * isLegacyError detection requires `type: 'system'` + `Error:` prefix.
 */

function createErrorService(catId, errorMsg) {
  return {
    async *invoke() {
      yield { type: 'error', catId, error: errorMsg, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMultipleErrorService(catId, errorMessages) {
  return {
    async *invoke() {
      for (const error of errorMessages) {
        yield { type: 'error', catId, error, timestamp: Date.now() };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** F212 Phase B (云端 codex P2-8): emit error with structured cliDiagnostics on metadata. */
function createCliErrorWithDiagnosticsService(catId, errorMsg, cliDiagnostics) {
  return {
    async *invoke() {
      yield {
        type: 'error',
        catId,
        error: errorMsg,
        metadata: { provider: 'test', model: 'test-model', cliDiagnostics },
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** F118 AC-C3: a provider gives up on a silent CLI — diagnostics, then the timeout error. */
function createTimeoutWithDiagnosticsService(catId, diagnostics, errorMsg) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'timeout_diagnostics', ...diagnostics }),
        timestamp: Date.now(),
      };
      yield { type: 'error', catId, error: errorMsg, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createTextThenErrorService(catId, text, errorMsg) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'error', catId, error: errorMsg, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls) {
  let invocationSeq = 0;
  let messageSeq = 0;

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
        };
        appendCalls.push(msg);
        return stored;
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getById: async () => null,
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('route-serial error persistence (F5 reload)', () => {
  async function lifecycleResponseStoreFor(input) {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const response = await store.append({
      from: { kind: 'agent', catId: input.catId },
      userId: input.userId,
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: input.startedAt,
      threadId: input.threadId,
      lifecycle: {
        kind: 'response',
        orderKey: `${input.startedAt}:${input.invocationId}`,
        invocationId: input.invocationId,
        targetId: input.catId,
        inputEntryIds: ['entry-1'],
        inputMessageIds: [],
        status: 'processing',
        startedAt: input.startedAt,
      },
    });
    return { store, response };
  }

  for (const strategy of ['serial', 'parallel']) {
    it(`${strategy}: persists an owned provider failure in the fixed member response without a system error row`, async () => {
      const route =
        strategy === 'serial'
          ? (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial
          : (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
      const deps = createMockDeps(
        {
          gemini: createMultipleErrorService('gemini', [
            'init_failure: first provider attempt failed',
            'init_failure: second provider attempt failed',
          ]),
        },
        [],
      );
      let lifecycleStore;
      let responseMessageId;
      const yielded = [];

      for await (const event of route(deps, ['gemini'], 'hello', 'user1', 'thread1', {
        onLifecycleInvocationStarted: async (input) => {
          const admission = await lifecycleResponseStoreFor(input);
          lifecycleStore = admission.store;
          deps.messageStore = admission.store;
          responseMessageId = admission.response.id;
          return { responseMessageId: admission.response.id, priorFrontierMessageId: null };
        },
      })) {
        yielded.push(event);
      }

      assert.ok(lifecycleStore, 'lifecycle store must be admitted before provider execution');
      const messages = lifecycleStore.getByThread('thread1', 100, 'user1');
      const response = messages.find((message) => message.id === responseMessageId);
      assert.equal(response?.from?.kind, 'agent');
      assert.equal(response?.from?.catId, 'gemini');
      assert.equal(response?.lifecycle?.kind, 'response');
      assert.equal(response?.lifecycle?.status, 'failed');
      assert.equal(
        response?.content,
        'init_failure: first provider attempt failed\ninit_failure: second provider attempt failed',
      );
      assert.equal(
        messages.some((message) => message.from?.kind === 'system' && message.from.service === 'agent-error'),
        false,
      );
      assert.equal(
        yielded.some((message) => message.type === 'error'),
        false,
        'a response-owned failure must update its canonical response instead of creating a live system error surface',
      );
    });

    it(`${strategy}: persists timeout diagnostics with the failed response they explain (F117 / F118)`, async () => {
      const route =
        strategy === 'serial'
          ? (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial
          : (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
      const deps = createMockDeps(
        {
          gemini: createTimeoutWithDiagnosticsService(
            'gemini',
            {
              silenceDurationMs: 1_800_000,
              processAlive: true,
              lastEventType: 'thread.started',
              invocationId: 'turn-timeout',
              terminalContext: { stderrExcerpt: 'never persisted' },
            },
            'CLI 响应超时 (1800s)',
          ),
        },
        [],
      );
      let lifecycleStore;
      let responseMessageId;

      for await (const _event of route(deps, ['gemini'], 'hello', 'user1', 'thread1', {
        onLifecycleInvocationStarted: async (input) => {
          const admission = await lifecycleResponseStoreFor(input);
          lifecycleStore = admission.store;
          deps.messageStore = admission.store;
          responseMessageId = admission.response.id;
          return { responseMessageId: admission.response.id, priorFrontierMessageId: null };
        },
      })) {
        // drain
      }

      const response = lifecycleStore
        .getByThread('thread1', 100, 'user1')
        .find((message) => message.id === responseMessageId);
      assert.equal(response?.lifecycle?.status, 'failed');
      assert.deepEqual(response?.metadata?.timeoutDiagnostics, {
        silenceDurationMs: 1_800_000,
        processAlive: true,
        lastEventType: 'thread.started',
        invocationId: 'turn-timeout',
      });
    });

    it(`${strategy}: closes a canceled run on the fixed member response without a silent-completion notice`, async () => {
      const route =
        strategy === 'serial'
          ? (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial
          : (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
      const controller = new AbortController();
      const deps = createMockDeps(
        {
          gemini: {
            async *invoke() {
              controller.abort('user_cancel');
              yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
            },
          },
        },
        [],
      );
      let lifecycleStore;
      let responseMessageId;
      const yielded = [];

      for await (const message of route(deps, ['gemini'], 'hello', 'user1', 'thread1', {
        signal: controller.signal,
        onLifecycleInvocationStarted: async (input) => {
          const admission = await lifecycleResponseStoreFor(input);
          lifecycleStore = admission.store;
          deps.messageStore = admission.store;
          responseMessageId = admission.response.id;
          return { responseMessageId: admission.response.id, priorFrontierMessageId: null };
        },
      })) {
        yielded.push(message);
      }

      assert.ok(lifecycleStore, 'lifecycle store must be admitted before cancellation');
      const response = lifecycleStore.getById(responseMessageId);
      assert.equal(response?.from?.kind, 'agent');
      assert.equal(response?.lifecycle?.kind, 'response');
      assert.equal(response?.lifecycle?.status, 'canceled');
      assert.equal(
        yielded.some(
          (message) => message.type === 'system_info' && String(message.content).includes('silent_completion'),
        ),
        false,
      );
    });
  }

  for (const strategy of ['serial', 'parallel']) {
    it(`${strategy}: reports a failed A2A response to the exact predecessor and suppresses recursive report carriers`, async () => {
      const route =
        strategy === 'serial'
          ? (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial
          : (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel;
      const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
      const { commitFailedResponseAndEnqueueA2ACaller } = await import('../dist/routes/callback-a2a-trigger.js');
      const deps = createMockDeps({ bengal: createErrorService('bengal', 'model unavailable') }, []);
      const queue = new InvocationQueue();
      const threadId = `failure-carrier-${strategy}`;
      let responseMessageId;
      const reportsForCurrentResponse = async () =>
        (await queue.listAllDurable(threadId)).filter((entry) => entry.payload.messageId === responseMessageId);
      const commonOptions = {
        a2aTriggerMessageId: 'source-from-opus',
        a2aCallerCatId: 'opus',
        onLifecycleInvocationStarted: async (input) => {
          const admission = await lifecycleResponseStoreFor(input);
          deps.messageStore = admission.store;
          responseMessageId = admission.response.id;
          return { responseMessageId, priorFrontierMessageId: null };
        },
        // Direct route callers can lack durable admission receipts. Exercise the
        // real transaction's legacy fallback, not the number of callback calls.
        commitFailedA2AReport: (input) =>
          commitFailedResponseAndEnqueueA2ACaller(
            {
              messageStore: deps.messageStore,
              invocationQueue: queue,
              queueProcessor: { requestDrain: async () => {} },
              socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
              log: { info() {}, warn() {}, error() {} },
            },
            input,
          ),
      };

      for await (const _ of route(deps, ['bengal'], 'please handle this', 'user1', threadId, commonOptions)) {
        void _;
      }
      const normalReports = await reportsForCurrentResponse();
      assert.equal(normalReports.length, 1);
      assert.equal(normalReports[0].from.catId, 'bengal');
      assert.deepEqual(normalReports[0].targets, ['opus']);
      assert.equal(normalReports[0].sourceCategory, 'a2a_failure');
      assert.equal(deps.messageStore.getById(responseMessageId).lifecycle.status, 'failed');
      assert.match(deps.messageStore.getById(responseMessageId).content, /model unavailable/);

      for await (const _ of route(deps, ['bengal'], 'failure report carrier', 'user1', threadId, {
        ...commonOptions,
        a2aFailureReport: true,
      })) {
        void _;
      }
      const recursiveReports = await reportsForCurrentResponse();
      assert.equal(recursiveReports.length, 0, 'a failed report carrier must not recurse back to its reporter');
      assert.equal(deps.messageStore.getById(responseMessageId).lifecycle.status, 'failed');
      assert.match(deps.messageStore.getById(responseMessageId).content, /model unavailable/);
    });
  }

  it('persists error-only response as system message with Error: prefix', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { gemini: createErrorService('gemini', 'stream_idle_stall: Gemini stopped responding') },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Should have one append: the system error message
    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'should persist a system error message');
    assert.ok(
      errorAppend.content.startsWith('Error:'),
      `system error content should start with "Error:" for legacy detection, got: ${errorAppend.content.slice(0, 60)}`,
    );
    assert.ok(errorAppend.content.includes('stream_idle_stall'), 'system error should contain the original error text');

    // No cat message with [错误] prefix should exist
    const catAppend = appendCalls.find((m) => m.from?.kind === 'agent' && m.from.catId === 'gemini');
    assert.equal(catAppend, undefined, 'error-only should NOT persist as cat message');
  });

  it('persists text+error as separate cat message + system error', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        gemini: createTextThenErrorService(
          'gemini',
          'Here is my partial response',
          'model_capacity: Server overloaded',
        ),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Cat message should have the text content WITHOUT [错误] contamination
    const catAppend = appendCalls.find((m) => m.from?.kind === 'agent' && m.from.catId === 'gemini');
    assert.ok(catAppend, 'should persist cat text message');
    assert.ok(!catAppend.content.includes('[错误]'), 'cat message should NOT contain [错误] prefix');
    assert.ok(catAppend.content.includes('partial response'), 'cat message should contain the actual response text');

    // System error message should also be persisted
    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'should persist a separate system error message');
    assert.ok(errorAppend.content.startsWith('Error:'), 'system error should start with Error: prefix');
    assert.ok(errorAppend.content.includes('model_capacity'), 'system error should contain the error code');
  });

  it('streams error event to frontend regardless of persistence', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ gemini: createErrorService('gemini', 'init_failure: CLI crashed') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Error should still be yielded to frontend for real-time display
    const errorMsg = yielded.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'error should be yielded to frontend');
    assert.ok(errorMsg.error.includes('init_failure'), 'yielded error should contain error text');
  });

  // F212 Phase B (云端 codex P2-8 2026-05-27): error message's metadata.cliDiagnostics must be
  // carried through to messageStore.append so F5 / cold hydration can re-render the folded panel.
  it('P2-8: persists metadata.cliDiagnostics on error system message for F5 hydration', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const cliDiagnostics = {
      reasonCode: 'auth_failed',
      publicSummary: 'API 认证失败',
      publicHint: '检查 .env API key',
      safeExcerpt: '401 Unauthorized',
      debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-test' },
    };
    const deps = createMockDeps(
      { gemini: createCliErrorWithDiagnosticsService('gemini', '401 Unauthorized', cliDiagnostics) },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      void _;
    }

    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'should persist a system error message');
    assert.ok(errorAppend.metadata, 'append must include metadata for hydration');
    assert.deepEqual(
      errorAppend.metadata.cliDiagnostics,
      cliDiagnostics,
      'cliDiagnostics must survive the active→persistence boundary',
    );
  });

  // F212 Phase B (云端 codex P2-8): regression — error without cliDiagnostics must NOT
  // introduce a phantom metadata field (keeps persisted rows minimal when no diagnostics).
  it('P2-8: error without cliDiagnostics does not add metadata to persisted row', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ gemini: createErrorService('gemini', 'plain error, no diag') }, appendCalls);

    for await (const _ of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      void _;
    }

    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'should persist a system error message');
    assert.equal(errorAppend.metadata, undefined, 'metadata must be absent when no cliDiagnostics');
  });

  // F167 Phase T cutover preserves F212's provider-error boundary: partial text
  // followed by a terminal error is never eligible for a structured stop-gate child.
  it('text+error path does not start a turn-custody stop-gate remedial child', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    let invokeCount = 0;
    let projectionCloseCount = 0;
    const codexService = {
      async *invoke() {
        invokeCount++;
        yield {
          type: 'text',
          catId: 'codex',
          content: 'Partial answer before upstream failure.',
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'codex',
          error: 'CLI 异常退出 (code: 1, signal: none)',
          metadata: {
            cliDiagnostics: {
              reasonCode: 'upstream_policy_reject',
              publicSummary: '上游 provider policy 拒绝',
              publicHint: 'try rephrasing',
              safeExcerpt: 'flagged for possible cybersecurity risk',
              debugRef: { command: 'codex', exitCode: 1, signal: null },
            },
          },
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ codex: codexService }, appendCalls);
    deps.turnCustodyProjectionService = {
      open: async () => ({
        state: 'covered_active',
        evidenceRefs: ['test:active-custody'],
        baseline: { kind: 'test' },
      }),
      close: async () => {
        projectionCloseCount++;
        return {
          state: 'covered_active',
          shouldBlock: true,
          transitionObserved: false,
          evidenceRefs: ['test:no-transition'],
        };
      },
    };

    for await (const _ of routeSerial(deps, ['codex'], 'crawl HN', 'user1', 'thread1', {
      turnCustodyWake: {
        kind: 'action_successor',
        leaseId: 'lease-error',
        generation: 1,
        holderCatId: 'codex',
      },
    })) {
      void _;
    }

    assert.equal(projectionCloseCount, 1, 'custody projection still records the failed turn');
    assert.equal(invokeCount, 1, 'provider-error turns must not start a stop-gate child');
    const catAppend = appendCalls.find((m) => m.from?.kind === 'agent' && m.from.catId === 'codex');
    assert.ok(catAppend, 'partial cat text should still persist');
    assert.ok(
      catAppend.content.includes('Partial answer'),
      'cat message should contain the partial pre-failure content',
    );
    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'terminal failure must persist as system error message');
    assert.ok(errorAppend.content.startsWith('Error:'), 'system error should carry Error: prefix for F5 rehydration');
    assert.equal(
      errorAppend.metadata?.cliDiagnostics?.reasonCode,
      'upstream_policy_reject',
      'F212 cliDiagnostics must flow through to persisted system error metadata',
    );
  });

  // F212 Phase H cloud R3 P1 (2026-07-10): AC-H4 fix gated only the REMEDIAL routing on
  // hadError. But a2aMentions parsed from partial text (line 2177) still fed the DOWNSTREAM
  // A2A enqueue loop at ~line 3015. Same defensive principle: a failed partial Codex turn
  // must NOT launch downstream cats from incomplete content. This test locks: partial text
  // with a valid line-start @mention followed by terminal error → NO downstream cat
  // invoked, even though the @mention is syntactically valid.
  it('F212 Phase H cloud R3 P1: partial text with @mention + terminal error → NO downstream A2A dispatch', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const codexInvokeCount = { n: 0 };
    const opusInvokeCount = { n: 0 };
    const codexService = {
      async *invoke() {
        codexInvokeCount.n++;
        // Partial text contains a valid line-start @mention — under R3 P1 fix, must NOT
        // dispatch @opus because the turn ended in error.
        yield {
          type: 'text',
          catId: 'codex',
          content: 'Partial handoff attempt.\n\n@opus please continue this.',
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'codex',
          error: 'CLI 异常退出 (code: 1, signal: none)',
          metadata: {
            cliDiagnostics: {
              reasonCode: 'upstream_policy_reject',
              debugRef: { command: 'codex', exitCode: 1, signal: null },
            },
          },
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const opusService = {
      async *invoke() {
        opusInvokeCount.n++;
        yield { type: 'text', catId: 'opus', content: 'opus taking over', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ codex: codexService, opus: opusService }, appendCalls);

    for await (const _ of routeSerial(deps, ['codex'], 'crawl HN', 'user1', 'thread1')) {
      void _;
    }

    assert.equal(codexInvokeCount.n, 1, 'codex service invoked once');
    assert.equal(
      opusInvokeCount.n,
      0,
      'cloud R3 P1 fix contract: partial @mention from a failed turn MUST NOT dispatch downstream cats',
    );
    const catAppend = appendCalls.find((m) => m.from?.kind === 'agent' && m.from.catId === 'codex');
    assert.ok(catAppend?.content.includes('Partial handoff'), 'partial content still persisted');
    const errorAppend = appendCalls.find((m) => m.from?.kind === 'system' && m.from.service === 'agent-error');
    assert.ok(errorAppend, 'terminal failure still surfaces as system error');
  });

  for (const fails of [false, true]) {
    it(`F212 lifecycle A2A admission follows the persisted provider outcome: failure=${fails}`, async () => {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
      const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
      const { commitCompletedResponseAndEnqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const { appendTestLifecycleResponseSource } = await import('./helpers/message-from-fixtures.js');
      const messages = new MessageStore();
      const queue = new InvocationQueue();
      const body = 'Handoff content\n@opus please continue';
      const service = {
        async *invoke() {
          yield { type: 'text', catId: 'codex', content: body, timestamp: Date.now() };
          if (fails) yield { type: 'error', catId: 'codex', error: 'provider failed', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      };
      const deps = createMockDeps({ codex: service }, []);
      deps.messageStore = messages;
      const persistenceContext = { errors: [], failed: false };
      let responseId;
      for await (const _ of routeSerial(deps, ['codex'], 'work', 'user1', 'thread1', {
        parentInvocationId: 'completed-response-parent',
        persistenceContext,
        onLifecycleInvocationStarted: async (input) => {
          const response = await appendTestLifecycleResponseSource(messages, {
            invocationId: input.invocationId,
            catId: input.catId,
            threadId: input.threadId,
            userId: input.userId,
            timestamp: input.startedAt,
          });
          responseId = response.id;
          return {
            responseMessageId: response.id,
            priorFrontierMessageId: null,
            activeRun: {
              threadId: input.threadId,
              targetId: input.catId,
              invocationId: input.invocationId,
              responseMessageId: response.id,
              inputEntryIds: [],
              inputMessageIds: [],
              privateInputEntryIds: [],
              startedAt: input.startedAt,
            },
          };
        },
        commitCompletedA2AWake: (input) =>
          commitCompletedResponseAndEnqueueA2ATargets(
            {
              messageStore: messages,
              invocationQueue: queue,
              queueProcessor: { async requestDrain() {} },
              socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
              log: { info() {}, warn() {}, error() {} },
            },
            input,
          ),
      })) {
        void _;
      }
      assert.deepEqual(persistenceContext.errors, []);
      const response = await messages.getById(responseId);
      assert.equal(response.lifecycle.status, fails ? 'failed' : 'completed');
      assert.ok(response.content.includes(body), 'the same persisted response retains its actual content');
      const pending = await queue.listAllDurable('thread1');
      assert.equal(pending.length, fails ? 0 : 1, 'only successful content may admit a downstream wake');
      if (!fails) {
        assert.equal(pending[0].payload.sourceRecordId, responseId);
        assert.deepEqual(pending[0].targets, ['opus']);
      }
    });
  }
});
