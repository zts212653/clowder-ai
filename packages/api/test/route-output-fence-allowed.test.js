import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F117 KD-21: when an action fence allows a gated child's output, the route records `allowed` on
 * the turn before anything commits R. A crash between the fence and the R commit then leaves a turn
 * the next startup may publish: the approved body survives instead of being withheld as unjudged.
 * Real routes, real invoke-single-cat, real in-memory stores, real startup settlement.
 */

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { lifecycleResponseIdempotencyKey, responseOutcomeForEndedTurn, settleResponseFromDraft } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);
const { TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

const USER = 'user-fence';
const THREAD = 'thread-fence';
const CAT = 'codex';
const ROUTES = { serial: routeSerial, parallel: routeParallel };

function textService(text) {
  return {
    async *invoke() {
      yield { type: 'text', catId: CAT, content: text, timestamp: Date.now() };
      yield { type: 'done', catId: CAT, timestamp: Date.now() };
    },
  };
}

/** One action-fenced queue dispatch: its invocation carries action custody, its child starts gated. */
function world(turns = new InMemoryTurnExecutionStore()) {
  const messages = new MessageStore();
  const drafts = new DraftStore();
  const records = new InvocationRecordStore();
  const parent = records.create({
    threadId: THREAD,
    userId: USER,
    targetCats: [CAT],
    intent: 'execute',
    idempotencyKey: `queue-entry-1:${CAT}`,
    actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease-1', generation: 1 },
  }).invocationId;
  const children = [];
  let sequence = 0;
  const deps = {
    services: { [CAT]: textService('APPROVED_OUTPUT') },
    invocationDeps: {
      registry: {
        create: () => {
          const invocationId = `child-${++sequence}`;
          children.push(invocationId);
          return { invocationId, callbackToken: `token-${sequence}` };
        },
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      turnExecutionStore: turns,
    },
    messageStore: messages,
    draftStore: drafts,
  };
  const fenceCalls = [];
  const options = {
    parentInvocationId: parent,
    beforeOutputCommit: async (catId) => {
      fenceCalls.push(catId);
      return true;
    },
    // The lifecycle admission creates R under the key settlement finds it by.
    onLifecycleInvocationStarted: async (input) => {
      const response = await messages.append({
        from: { kind: 'agent', catId: input.catId },
        userId: input.userId,
        content: '',
        mentions: [],
        origin: 'stream',
        timestamp: input.startedAt,
        threadId: input.threadId,
        idempotencyKey: lifecycleResponseIdempotencyKey(input.invocationId),
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
      return { responseMessageId: response.id, priorFrontierMessageId: null };
    },
  };
  return { messages, drafts, turns, records, deps, options, children, fenceCalls };
}

/** The process dies at R's commit: nothing after the fence reaches the message store. */
function crashAtResponseCommit(messages) {
  const commit = messages.commitLifecycleResponseTerminal.bind(messages);
  let crashed = false;
  messages.commitLifecycleResponseTerminal = async (id, patch) => {
    if (!crashed) {
      crashed = true;
      throw new Error('process died before R committed');
    }
    return commit(id, patch);
  };
}

async function drain(iterable) {
  for await (const _event of iterable) {
    // The route's own events are not under test.
  }
}

/** Production startup wiring: the next process settles every ended turn left in the ledger. */
function nextStartup({ messages, drafts, turns, records }) {
  return new TurnExecutionStartupReconciler({
    store: turns,
    settleEndedTurnResponse: (turn) =>
      settleResponseFromDraft(
        { messageStore: messages, draftStore: drafts, turnStore: turns, invocationRecords: records },
        {
          userId: turn.userId,
          threadId: turn.threadId,
          invocationId: turn.invocationId,
          ...responseOutcomeForEndedTurn(turn),
        },
      ),
  }).reconcile({ processStartedAt: Date.now() + 1_000 });
}

/** Every interval the code under test starts, minus those it clears. */
function trackIntervals() {
  const live = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => {
    const handle = realSet(...args);
    live.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    live.delete(handle);
    return realClear(handle);
  };
  return {
    live,
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      for (const handle of live) realClear(handle);
    },
  };
}

function responseOf(messages, invocationId) {
  return messages.getByThread(THREAD, 100, USER).find((message) => message.lifecycle?.invocationId === invocationId);
}

describe('F117 KD-21 a fence-approved output survives a crash before its R commit', () => {
  for (const [strategy, route] of Object.entries(ROUTES)) {
    it(`${strategy}: the approved draft is published by the next startup`, async () => {
      const w = world();
      crashAtResponseCommit(w.messages);

      await drain(route(w.deps, [CAT], 'please act', USER, THREAD, w.options));

      const [child] = w.children;
      assert.deepEqual(w.fenceCalls, [CAT]);
      assert.equal((await w.turns.get(child)).outputFence, 'allowed', 'the verdict is durable before R commits');
      assert.equal(responseOf(w.messages, child).lifecycle.status, 'processing', 'the crash left R uncommitted');

      const restart = await nextStartup(w);

      assert.equal(restart.settledResponseCount, 1);
      const response = responseOf(w.messages, child);
      assert.equal(response.lifecycle.status, 'interrupted');
      assert.equal(response.lifecycle.reason, 'process_restart');
      assert.equal(response.content, 'APPROVED_OUTPUT');
      assert.deepEqual(await w.drafts.getByThread(USER, THREAD), []);
      assert.deepEqual(await w.turns.listResponsePending(), []);
    });

    it(`${strategy}: an allowed verdict that cannot be recorded stops the commit`, async () => {
      const turns = new InMemoryTurnExecutionStore();
      turns.settleOutputFence = async () => {
        throw new Error('redis unavailable');
      };
      const w = world(turns);
      const intervals = trackIntervals();

      try {
        await assert.rejects(drain(route(w.deps, [CAT], 'please act', USER, THREAD, w.options)), /redis unavailable/);
        assert.equal(intervals.live.size, 0, 'a route that throws leaves no interval running');
      } finally {
        intervals.restore();
      }

      const [child] = w.children;
      assert.equal((await w.turns.get(child)).outputFence, 'gated');
      const response = responseOf(w.messages, child);
      assert.equal(response.lifecycle.status, 'processing', 'no body was committed without the durable verdict');
      assert.equal(response.content, '');
    });
  }
});
