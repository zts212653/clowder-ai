import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

let auditDir;
let originalAuditDir;
let originalPreflightDisable;

before(async () => {
  auditDir = await mkdtemp(join(tmpdir(), 'turn-execution-audit-'));
  originalAuditDir = process.env.AUDIT_LOG_DIR;
  originalPreflightDisable = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  process.env.AUDIT_LOG_DIR = auditDir;
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
});

after(async () => {
  if (originalAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = originalAuditDir;
  if (originalPreflightDisable === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalPreflightDisable;
  await rm(auditDir, { recursive: true, force: true });
});

function makeDeps(store, invocationId) {
  return {
    registry: {
      create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    turnExecutionStore: store,
  };
}

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

describe('invokeSingleCat durable child execution lifecycle', () => {
  test('creates running before prompt exposure/provider and terminalizes success', async () => {
    const store = new InMemoryTurnExecutionStore();
    const exposureCalls = [];
    let providerObservedStatus;
    let providerRecoveryAnchor;
    const service = {
      async *invoke(_prompt, options) {
        providerObservedStatus = (await store.get('child-success'))?.status;
        providerRecoveryAnchor = options.recoveryAnchor;
        assert.equal(exposureCalls.length, 1, 'body exposure must be durable before provider starts');
        yield { type: 'text', catId: 'codex', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const messages = await collect(
      invokeSingleCat(makeDeps(store, 'child-success'), {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user-1',
        threadId: 'thread-1',
        parentInvocationId: 'parent-1',
        executionKind: 'freshness_supplement',
        executionCausal: {
          triggerMessageId: 'msg-trigger',
          freshnessSupplementId: 'supplement-1',
        },
        promptMessageIds: ['msg-queued'],
        onPromptMessagesExposed: async (input) => exposureCalls.push(input),
        isLastCat: true,
      }),
    );

    assert.equal(providerObservedStatus, 'running');
    assert.deepEqual(providerRecoveryAnchor, {
      threadId: 'thread-1',
      invocationId: 'child-success',
      promptMessageIds: ['msg-queued'],
    });
    assert.equal(exposureCalls.length, 1);
    assert.equal(exposureCalls[0].invocationId, 'child-success');
    assert.deepEqual(exposureCalls[0].messageIds, ['msg-queued']);
    assert.equal(Number.isFinite(exposureCalls[0].seenAt), true);
    const created = messages.find((message) => {
      if (message.type !== 'system_info' || !message.content) return false;
      return JSON.parse(message.content).type === 'invocation_created';
    });
    assert.deepEqual(JSON.parse(created.content), {
      type: 'invocation_created',
      invocationId: 'child-success',
      parentInvocationId: 'parent-1',
      executionKind: 'freshness_supplement',
      startedAt: JSON.parse(created.content).startedAt,
    });
    assert.equal(created.turnInvocationId, 'child-success');
    assert.equal(created.turnExecutionStartedAt, JSON.parse(created.content).startedAt);
    assert.deepEqual(created.extra?.turnExecution, {
      invocationId: 'child-success',
      parentInvocationId: 'parent-1',
      executionKind: 'freshness_supplement',
    });

    const terminal = await store.get('child-success');
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.executionKind, 'freshness_supplement');
    assert.deepEqual(terminal.causal, {
      triggerMessageId: 'msg-trigger',
      freshnessSupplementId: 'supplement-1',
      coveredMessageIds: ['msg-queued'],
    });
    assert.equal(terminal.endedAt >= terminal.startedAt, true);
    assert.equal(terminal.terminalReason, undefined);
  });

  test('provider terminal error becomes failed with a canonical reason and no durable error detail copy', async () => {
    const store = new InMemoryTurnExecutionStore();
    const service = {
      async *invoke() {
        yield {
          type: 'error',
          catId: 'codex',
          error: 'provider_boom secret-token-should-not-persist',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(makeDeps(store, 'child-failed'), {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user-1',
        threadId: 'thread-1',
        parentInvocationId: 'parent-1',
        executionKind: 'routing_guard',
        executionCausal: { routingGuardReason: 'missing_routing_exit' },
        isLastCat: true,
      }),
    );

    const terminal = await store.get('child-failed');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.terminalReason, 'provider_execution_failed');
    assert.doesNotMatch(JSON.stringify(terminal), /secret-token-should-not-persist/);
  });

  test('provider iterator ending without terminal done is interrupted, never succeeded', async () => {
    const store = new InMemoryTurnExecutionStore();
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'partial', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(makeDeps(store, 'child-missing-done'), {
        catId: 'codex',
        service,
        prompt: 'test',
        userId: 'user-1',
        threadId: 'thread-1',
        parentInvocationId: 'parent-1',
        isLastCat: true,
      }),
    );

    const terminal = await store.get('child-missing-done');
    assert.equal(terminal.status, 'interrupted');
    assert.equal(terminal.terminalReason, 'provider_ended_without_terminal_done');
  });

  test('consumer stopping immediately after terminal done still records succeeded', async () => {
    const store = new InMemoryTurnExecutionStore();
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'complete', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const iterator = invokeSingleCat(makeDeps(store, 'child-stop-after-done'), {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user-1',
      threadId: 'thread-1',
      parentInvocationId: 'parent-1',
      isLastCat: true,
    })[Symbol.asyncIterator]();

    let terminalDone;
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, 'provider done must be yielded before generator completion');
      if (next.value.type === 'done') {
        terminalDone = next.value;
        break;
      }
    }
    assert.equal(terminalDone.type, 'done');
    await iterator.return(undefined);

    const terminal = await store.get('child-stop-after-done');
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.terminalReason, undefined);
  });

  test('force-return after invocation_created terminalizes interrupted instead of leaving an auth-only child', async () => {
    const store = new InMemoryTurnExecutionStore();
    let providerCalled = false;
    const service = {
      async *invoke() {
        providerCalled = true;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const iterator = invokeSingleCat(makeDeps(store, 'child-returned'), {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user-1',
      threadId: 'thread-1',
      parentInvocationId: 'parent-1',
      isLastCat: true,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    assert.equal(JSON.parse(first.value.content).type, 'invocation_created');
    await iterator.return(undefined);

    assert.equal(providerCalled, false);
    assert.deepEqual(await store.get('child-returned'), {
      invocationId: 'child-returned',
      parentInvocationId: 'parent-1',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: (await store.get('child-returned')).startedAt,
      status: 'interrupted',
      endedAt: (await store.get('child-returned')).endedAt,
      terminalReason: 'generator_returned_without_completion',
    });
  });

  test('a replayed child create never starts a second provider or steals terminal ownership', async () => {
    const canonicalStore = new InMemoryTurnExecutionStore();
    let createCalls = 0;
    const replayingStore = {
      createRunning(input) {
        createCalls += 1;
        if (createCalls === 1) return canonicalStore.createRunning(input);
        return { outcome: 'replayed', record: canonicalStore.get(input.invocationId) };
      },
      get: (invocationId) => canonicalStore.get(invocationId),
      listByParent: (parentInvocationId) => canonicalStore.listByParent(parentInvocationId),
      transitionTerminal: (invocationId, input) => canonicalStore.transitionTerminal(invocationId, input),
      interruptRunningBefore: (cutoff, input) => canonicalStore.interruptRunningBefore(cutoff, input),
    };
    let providerCalls = 0;
    const service = {
      async *invoke() {
        providerCalls += 1;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const params = {
      catId: 'codex',
      service,
      prompt: 'test',
      userId: 'user-1',
      threadId: 'thread-1',
      parentInvocationId: 'parent-1',
      isLastCat: true,
    };

    await collect(invokeSingleCat(makeDeps(replayingStore, 'child-replayed'), params));
    const firstTerminal = canonicalStore.get('child-replayed');
    const replayMessages = await collect(invokeSingleCat(makeDeps(replayingStore, 'child-replayed'), params));

    assert.equal(providerCalls, 1);
    assert.deepEqual(canonicalStore.get('child-replayed'), firstTerminal);
    assert.match(
      replayMessages.find((message) => message.type === 'error')?.error ?? '',
      /turn_execution_not_created:replayed/,
    );
  });
});
