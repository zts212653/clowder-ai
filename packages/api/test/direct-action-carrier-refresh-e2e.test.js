/**
 * F167 carrier refresh — end to end, with a real provider boundary.
 *
 * Real: callback route, atomic InvocationQueue/History admission, QueueProcessor,
 * MessageStore, InvocationRecordStore, the lease transition and the carrier recognition.
 * Faked at the edges only: the admission service answers `safe_wait` for an existing lease, the lease
 * store runs the real state machine in memory, and the provider (`router.routeExecution`) is a counter.
 *
 * The first generation is NOT hand-built evidence: it runs through the real processor, so the
 * exact response/dispatchRef and succeeded InvocationRecord the refresh relies on are what production
 * actually writes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  canonicalizeActionIdentity,
  preflightActionSuccessor,
  recordActionSuccessorOutcome,
  refreshHandledActionSuccessor,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';
import {
  actionSuccessorCarrierKey,
  actionSuccessorInvocationKeyForTarget,
  InvocationQueue,
} from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  MessageStore,
  settleLifecycleResponseInputs,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const SUBJECT = 'subject:task:task-4058';
const HOLDER = 'codex';
const PREDECESSOR = 'opus';
const ACTION = {
  subjectRef: SUBJECT,
  actionFamily: 'implement',
  successorSlot: 'implementer',
  mode: 'single',
  terminalPredicate: { kind: 'task_done' },
};

function initialLease(sourceThreadId, holderThreadId) {
  return {
    leaseId: 'lease-4058',
    ...canonicalizeActionIdentity({
      tenantScope: 'user-1',
      subjectRef: SUBJECT,
      actionFamily: 'implement',
      successorSlot: 'implementer',
    }),
    mode: 'single',
    holderCatIds: [HOLDER],
    dispatchId: 'cross-post:original-4058',
    claimOrigin: 'structured_transfer',
    holderThreadId,
    predecessorCatId: PREDECESSOR,
    predecessorThreadId: sourceThreadId,
    issuerStandingEvidenceRef: 'callback:old-invocation:original-4058',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: SUBJECT,
      predicate: ACTION.terminalPredicate,
    }),
    evidenceRefs: ['callback:old-invocation:original-4058'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
  };
}

/**
 * In-memory lease store over the REAL state machine. The same object backs the route (refresh) and the
 * QueueProcessor (start preflight), so an old generation's carrier is refused once the lease advanced.
 */
function createLeaseStore(initial) {
  let current = initial;
  return {
    get current() {
      return current;
    },
    install(lease) {
      current = lease;
    },
    observed: undefined,
    async refreshHandledCarrier(leaseId, input) {
      assert.equal(leaseId, current.leaseId);
      const result = refreshHandledActionSuccessor(current, input);
      if (result.outcome === 'refreshed') current = result.lease;
      return result;
    },
    async getSubjectTerminal() {
      return null;
    },
    async preflight(leaseId, generation, terminalPredicateDigest) {
      assert.equal(leaseId, current.leaseId);
      return preflightActionSuccessor(current, { generation, subjectTerminal: false, terminalPredicateDigest });
    },
    async preflightOutput(_leaseId, generation, catId, terminalPredicateDigest) {
      const gate = preflightActionSuccessor(current, { generation, subjectTerminal: false, terminalPredicateDigest });
      if (!gate.ok) return gate;
      if (!current.holderCatIds.includes(catId)) return { ok: false, reason: 'holder_not_assigned' };
      return { ok: true, reason: 'active' };
    },
    async commitOutcome() {
      assert.fail('a successful carrier must not commit a holder outcome');
    },
  };
}

/**
 * The real record store, except what the route reads for the OLD carrier's execution: the exact-key lookup, and
 * optionally the one persistent record `hiddenRecordId` that custody's lineage would otherwise lead to.
 */
function withRecordLookup(records, lookup, hiddenRecordId, recordById) {
  return new Proxy(records, {
    get(target, property) {
      if (property === 'getByIdempotencyKey') return lookup;
      if (property === 'get' && recordById) return recordById;
      if (property === 'get' && hiddenRecordId) return (id) => (id === hiddenRecordId ? null : target.get(id));
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('direct action carrier refresh, route to provider', () => {
  let app;
  let messages;
  let queue;
  let records;
  let registry;
  let source;
  let target;
  let auth;
  let leaseStore;
  let unavailable;
  let starts;
  let warnings;
  let threadStore;
  let turns;
  /** Resolved by default; a test replaces it to keep a provider run in flight until it releases it. */
  let providerGate;

  /** Original generation uses the same atomic admission and response contract as the public route. */
  async function runOriginalGeneration(lease) {
    leaseStore.install(lease);
    const fence = buildActionSuccessorFence(lease, lease.dispatchId);
    const from = { kind: 'agent', catId: PREDECESSOR };
    const queued = await queue.send(
      messages,
      {
        userId: 'user-1',
        threadId: target.id,
        from,
        content: 'Implement task (original)',
        mentions: [HOLDER],
        origin: 'callback',
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        idempotencyKey: actionSuccessorCarrierKey(fence, HOLDER),
      },
      {
        kind: 'conversation_input',
        threadId: target.id,
        userId: 'user-1',
        from,
        ownerAuthProvenance: 'strict',
        content: 'Implement task (original)',
        sourceCategory: 'a2a',
        targetCats: [HOLDER],
        intent: 'execute',
        autoExecute: true,
        actionSuccessorFence: fence,
      },
    );
    assert.equal(queued.outcome, 'enqueued');
    const { message, entry } = queued;
    assert.ok(message && entry);
    assert.ok(['started', 'already_processing'].includes(await processor.progressOwnedCarrier(entry, HOLDER)));
    for (let attempt = 0; attempt < 200; attempt++) {
      const ref = messages.getById(message.id)?.lifecycle?.dispatchRefs?.[0];
      if (ref?.phase === 'settled') return { message, fence };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(
      'original generation never settled: ' +
        JSON.stringify({
          starts,
          warnings,
          source: messages.getById(message.id),
          entry: queue.list(target.id, 'user-1'),
        }),
    );
  }

  let processor;

  beforeEach(async () => {
    leaseStore = createLeaseStore(undefined);
    app = Fastify();
    messages = new MessageStore();
    queue = new InvocationQueue(undefined, {
      onAdmitted: ({ threadId }) => {
        void processor.requestDrain(threadId);
      },
    });
    records = new InvocationRecordStore();
    registry = new InvocationRegistry();
    unavailable = [];
    starts = [];
    warnings = [];
    app.log.warn = (...args) =>
      warnings.push(['route-warn', ...args.map((arg) => (arg?.err ? { ...arg, err: String(arg.err) } : arg))]);
    app.log.error = (...args) =>
      warnings.push(['route-error', ...args.map((arg) => (arg?.err ? { ...arg, err: String(arg.err) } : arg))]);
    providerGate = Promise.resolve();
    threadStore = new ThreadStore();
    source = await threadStore.create('user-1', 'Author');
    target = await threadStore.create('user-1', 'Implementer');
    // A real callback caller is a running child turn of its parent invocation, and a route that holds the
    // turn ledger requires exactly that; the predecessor here is one.
    const callerParentId = randomUUID();
    auth = await registry.create('user-1', PREDECESSOR, source.id, callerParentId);
    turns = new InMemoryTurnExecutionStore();
    turns.createRunning({
      invocationId: auth.invocationId,
      parentInvocationId: callerParentId,
      threadId: source.id,
      userId: 'user-1',
      catId: PREDECESSOR,
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    processor = new QueueProcessor({
      queue,
      invocationTracker: new InvocationTracker(),
      messageStore: messages,
      turnExecutionStore: turns,
      invocationRecordStore: records,
      actionSuccessorLeaseStore: leaseStore,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: {
        info: (...args) => warnings.push(['info', ...args]),
        warn: (...args) => warnings.push(['warn', ...args]),
        error: (...args) => warnings.push(['error', ...args]),
      },
      router: {
        async resolveExplicitTargets(targets) {
          return [...targets];
        },
        async resolveConversationTargetsAtAdmission(targets) {
          return [...targets];
        },
        async *routeExecution(userId, _content, threadId, messageId, targets, _intent, options) {
          const catId = targets[0];
          const invocationId = randomUUID();
          const parentInvocationId = String(options?.parentInvocationId);
          starts.push({ threadId, invocationId, parentInvocationId, messageId });
          const startedAt = Date.now();
          turns.createRunning({
            invocationId,
            parentInvocationId,
            threadId,
            userId,
            catId,
            startedAt,
            executionKind: 'ordinary',
            causal: { triggerMessageId: messageId },
          });
          const admission = await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId,
            invocationId,
            parentInvocationId,
            startedAt,
          });
          yield {
            type: 'system_info',
            catId,
            lifecycleResponseMessageId: admission.responseMessageId,
            activeRun: admission.activeRun,
            turnInvocationId: invocationId,
            turnExecutionStartedAt: startedAt,
            timestamp: startedAt,
            content: JSON.stringify({ type: 'invocation_created', invocationId }),
            extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
          };
          await options?.onPromptMessagesExposed?.({
            threadId,
            userId,
            catId,
            invocationId,
            messageIds: options?.persistedPromptMessageIds,
            seenAt: Date.now(),
          });
          // A real provider answers; route-serial asks the Queue to revalidate the lease before it lets
          // that output out, so the boundary must do the same or the run is (correctly) suppressed.
          await providerGate;
          const outputAllowed = options?.beforeOutputCommit ? await options.beforeOutputCommit(catId) : true;
          if (outputAllowed) {
            yield { type: 'text', catId, content: 'Continuing the implementation.', timestamp: Date.now() };
          }
          turns.transitionTerminal(invocationId, { status: 'succeeded', endedAt: Date.now() });
          const terminal = messages.commitLifecycleResponseTerminal(admission.responseMessageId, {
            invocationId,
            status: 'completed',
            completedAt: Date.now(),
            content: 'Continuing the implementation.',
            mentions: [],
            origin: 'stream',
          });
          assert.equal(terminal.kind, 'applied');
          await settleLifecycleResponseInputs(messages, terminal.message, admission.responseMessageId);
          yield { type: 'done', catId, invocationId, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function registerRoute({ withLeaseStore = true, executionRecord, hiddenRecordId, recordById } = {}) {
    await app.register(callbacksRoutes, {
      registry,
      messageStore: messages,
      threadStore,
      invocationQueue: queue,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: executionRecord
        ? withRecordLookup(records, executionRecord, hiddenRecordId, recordById)
        : records,
      turnExecutionStore: turns,
      queueProcessor: processor,
      ...(withLeaseStore ? { actionSuccessorLeaseStore: leaseStore } : {}),
      actionSuccessorAdmissionService: {
        // The route asks this for an EXISTING lease; `observed` lets a test force two requests to read
        // the same pre-refresh lease, the way two real concurrent callers would.
        async admit(input) {
          const observed = leaseStore.observed ?? leaseStore.current;
          if (observed.dispatchId === input.dispatchId) {
            return { admit: false, outcome: 'replayed', lease: leaseStore.current };
          }
          return { admit: false, outcome: 'safe_wait', lease: observed };
        },
        async markUnavailable(input) {
          unavailable.push(input);
        },
      },
    });
  }

  function post(clientMessageId, overrides = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: 'Please continue the implementation',
        targetCats: [HOLDER],
        clientMessageId,
        action: ACTION,
        ...overrides,
      },
    });
  }

  async function settleExecutions(expectedStarts) {
    for (let attempt = 0; attempt < 300 && starts.length < expectedStarts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Let the processor finish its terminal bookkeeping for the run that just started.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  test('a handled generation is refreshed onto generation 2 and the real provider starts exactly once more', async () => {
    const lease = initialLease(source.id, target.id);
    const original = await runOriginalGeneration(lease);
    assert.equal(starts.length, 1, 'the original generation ran once');
    const oldKey = actionSuccessorInvocationKeyForTarget(original.message.id, HOLDER);
    const oldRecord = records.getByIdempotencyKey(target.id, 'user-1', oldKey);
    assert.equal(oldRecord?.status, 'succeeded');
    assert.deepEqual(oldRecord?.successfulCatIds, [HOLDER]);
    await registerRoute();

    const response = await post('refresh-4058-first');

    assert.equal(response.statusCode, 200, response.body + JSON.stringify(warnings));
    assert.deepEqual(response.json().actionLease, { leaseId: 'lease-4058', generation: 2, outcome: 'refreshed' });
    assert.equal(leaseStore.current.generation, 2);
    assert.equal(leaseStore.current.dispatchId, 'cross-post:refresh-4058-first');

    await settleExecutions(2);
    assert.equal(starts.length, 2, 'exactly one new provider start for the refreshed carrier');
    const newKey = actionSuccessorInvocationKeyForTarget(starts[1].messageId, HOLDER);
    const newRecord = records.getByIdempotencyKey(target.id, 'user-1', newKey);
    assert.ok(newRecord, 'the refreshed carrier created its own InvocationRecord');
    assert.notEqual(newRecord.id, oldRecord.id);
    assert.equal(records.getByIdempotencyKey(target.id, 'user-1', oldKey)?.id, oldRecord.id, 'old record untouched');
    assert.deepEqual(unavailable, []);
    assert.equal(
      warnings.some((args) => args.some((part) => String(part).includes('Duplicate invocation'))),
      false,
      'the new generation must not be swallowed as a duplicate of the old one',
    );
  });

  test('a handled generation older than the 5-minute key index is still refreshed, found through the child ledger', async (t) => {
    const lease = initialLease(source.id, target.id);
    const original = await runOriginalGeneration(lease);
    assert.equal(starts.length, 1, 'the original generation ran once');
    const oldKey = actionSuccessorInvocationKeyForTarget(original.message.id, HOLDER);
    const parent = records.getByIdempotencyKey(target.id, 'user-1', oldKey);
    assert.equal(parent?.id, starts[0].parentInvocationId, 'the Queue created the PARENT record from the carrier key');
    const ref = messages.getById(original.message.id).lifecycle.dispatchRefs[0];
    const result = messages.getById(ref.statusMessageId);
    assert.equal(result.lifecycle.invocationId, starts[0].invocationId, 'History names the exact child');
    assert.notEqual(result.lifecycle.invocationId, parent.id);
    assert.equal(ref.phase, 'settled');

    // What production showed after 5 minutes: the exact key no longer finds the run, the records do not expire.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(5 * 60 * 1000 + 1000);
    assert.equal(records.getByIdempotencyKey(target.id, 'user-1', oldKey), null, 'the key index has expired');
    assert.equal(records.get(parent.id)?.status, 'succeeded', 'the parent record is still there');
    assert.equal(records.get(starts[0].invocationId), null, 'the child turn is not an InvocationRecord');
    // Real time comes back for the new execution; only the OBSERVED expired key stays unavailable.
    t.mock.timers.reset();
    await registerRoute({
      executionRecord: async (threadId, userId, key) =>
        key === oldKey ? null : records.getByIdempotencyKey(threadId, userId, key),
    });

    const response = await post('refresh-4058-after-index-expiry');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().actionLease, { leaseId: 'lease-4058', generation: 2, outcome: 'refreshed' });
    await settleExecutions(2);
    assert.equal(starts.length, 2, 'exactly one new provider start for the refreshed carrier');
    assert.deepEqual(unavailable, []);
  });

  test('CONTROL: the same dispatch without advancing the generation starts no provider at all', async () => {
    const lease = initialLease(source.id, target.id);
    const original = await runOriginalGeneration(lease);
    assert.equal(starts.length, 1);

    const from = { kind: 'agent', catId: PREDECESSOR };
    await assert.rejects(
      queue.send(
        messages,
        {
          threadId: target.id,
          userId: 'user-1',
          from,
          content: 'Implement task (original)',
          mentions: [HOLDER],
          origin: 'callback',
          timestamp: original.message.timestamp,
          deliveryStatus: 'queued',
          idempotencyKey: actionSuccessorCarrierKey(original.fence, HOLDER),
        },
        {
          kind: 'conversation_input',
          threadId: target.id,
          userId: 'user-1',
          from,
          ownerAuthProvenance: 'strict',
          content: 'Implement task (original)',
          sourceCategory: 'a2a',
          targetCats: [HOLDER],
          intent: 'execute',
          autoExecute: true,
          actionSuccessorFence: original.fence,
        },
      ),
      /Queue admission identity conflict/,
      'a retired delivery cannot be submitted as a fresh admission',
    );
    assert.equal(queue.list(target.id, 'user-1').length, 0);
    await processor.requestDrain(target.id);
    assert.equal(starts.length, 1, 'the same generation never reaches the provider again');
  });
  test('two concurrent refreshes of the same observed lease yield exactly one carrier and one new execution', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    await registerRoute();
    leaseStore.observed = lease; // both callers read the pre-refresh generation

    const [first, second] = await Promise.all([post('refresh-4058-a'), post('refresh-4058-b')]);

    const bodies = [first.json(), second.json()];
    // Exactly one request owns the refresh. The other lost the commit and may only say what is true of
    // the lease that is current: its carrier is live (safe_wait), not persisted yet (carrier_missing) or
    // already finished (lease_changed). Which one depends on how far the winner got, so the invariant
    // is what it can NEVER be: a second refresh of the generation the winner just created.
    const winners = bodies.filter((body) => body.status === 'ok');
    assert.equal(winners.length, 1, 'exactly one request refreshed the lease');
    assert.equal(winners[0].actionLease.generation, 2);
    const loser = bodies.find((body) => body.status !== 'ok');
    const loserResponse = first.json().status === 'ok' ? second : first;
    if (loser.status === 'safe_wait') {
      assert.equal(loserResponse.statusCode, 200);
      assert.equal(loser.actionLease.generation, 2, 'safe_wait names the generation that is actually live');
    } else {
      assert.equal(loserResponse.statusCode, 409);
      assert.equal(loser.status, 'action_carrier_unavailable');
      assert.ok(['carrier_missing', 'lease_changed'].includes(loser.reason), loser.reason);
    }
    assert.equal(leaseStore.current.generation, 2);
    await settleExecutions(2);
    assert.equal(starts.length, 2, 'one original run plus exactly one refreshed run');
    const carriers = queue.list(target.id, 'user-1').filter((entry) => entry.actionSuccessorFence?.generation === 2);
    assert.ok(carriers.length <= 1, 'at most one generation-2 carrier is ever queued');
    assert.deepEqual(unavailable, []);
  });

  test('a loser that reads the winner while its carrier is running is told safe_wait for that generation', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    await registerRoute();
    let release;
    providerGate = new Promise((resolve) => {
      release = resolve;
    });
    leaseStore.observed = lease; // the second caller still holds the pre-refresh observation

    const winner = await post('refresh-4058-winner');
    assert.equal(winner.statusCode, 200, winner.body);
    await settleExecutions(2); // generation 2 is now running, held in flight by the gate
    const loser = await post('refresh-4058-loser');

    assert.equal(loser.statusCode, 200, loser.body);
    assert.equal(loser.json().status, 'safe_wait');
    assert.equal(loser.json().actionLease.generation, 2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(starts.length, 2, 'the loser started nothing');
  });

  test('a loser that reads the winner AFTER its run finished is told lease_changed and starts no third generation', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    await registerRoute();
    leaseStore.observed = lease;

    const winner = await post('refresh-4058-first');
    assert.equal(winner.statusCode, 200, winner.body);
    await settleExecutions(2);
    const loser = await post('refresh-4058-late');

    assert.equal(loser.statusCode, 409, loser.body);
    assert.equal(loser.json().reason, 'lease_changed');
    assert.equal(leaseStore.current.generation, 2, 'the overlapping ask did not advance the lease again');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(starts.length, 2);
  });

  test('a same-request retry after a crash between the commit and the append converges on one carrier', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    // The first attempt committed generation 2 (and claimed its clientMessageId) and then died.
    const committed = refreshHandledActionSuccessor(lease, {
      expectedGeneration: 1,
      expectedRevision: lease.revision,
      predecessorCatId: PREDECESSOR,
      predecessorThreadId: source.id,
      holderCatIds: [HOLDER],
      holderThreadId: target.id,
      mode: 'single',
      terminalPredicateDigest: lease.terminalPredicate.digest,
      dispatchId: 'cross-post:refresh-4058-crash',
      evidenceRef: `callback:${auth.invocationId}:refresh-4058-crash`,
      now: Date.now(),
    });
    assert.equal(committed.outcome, 'refreshed');
    leaseStore.install(committed.lease);
    assert.equal(await registry.claimClientMessageId(auth.invocationId, 'refresh-4058-crash'), true);
    await registerRoute();

    const retry = await post('refresh-4058-crash');
    assert.equal(retry.statusCode, 200, retry.body);
    await settleExecutions(2);
    const recoveryKey = 'action-carrier-recovery:lease-4058:2';
    const stored = messages.getByIdempotencyKey('user-1', target.id, recoveryKey);
    assert.ok(stored, 'the replacement carrier is appended under its stable recovery key');
    const carrierMessages = () =>
      messages
        .getByThreadIncludingQueued(target.id, 50, 'user-1')
        .filter((message) => message.catId === PREDECESSOR && message.mentions.includes(HOLDER));
    assert.equal(carrierMessages().length, 2, 'the original carrier plus exactly one replacement');
    assert.equal(starts.length, 2, 'one original run plus one run for the recovered carrier');

    const again = await post('refresh-4058-crash');
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().messageId, stored.id, 'a second retry names the same single message');
    const changed = await post('refresh-4058-crash', { content: 'A different continuation' });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().kind, 'action_carrier_idempotency_conflict');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(carrierMessages().length, 2, 'and appends nothing new');
    assert.equal(starts.length, 2, 'and starts nothing new');
  });

  test('an actor that is not the stored predecessor can neither refresh nor consult the record', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    const otherParentId = randomUUID();
    const other = await registry.create('user-1', 'codex', source.id, otherParentId);
    turns.createRunning({
      invocationId: other.invocationId,
      parentInvocationId: otherParentId,
      threadId: source.id,
      userId: 'user-1',
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    let lookups = 0;
    await registerRoute({
      executionRecord: async () => {
        lookups += 1;
        return null;
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': other.invocationId, 'x-callback-token': other.callbackToken },
      payload: {
        threadId: target.id,
        content: 'Hijack',
        targetCats: [HOLDER],
        clientMessageId: 'refresh-4058-intruder',
        action: ACTION,
      },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().reason, 'authority_mismatch');
    assert.equal(lookups, 0);
    assert.equal(leaseStore.current.generation, 1);
    assert.equal(starts.length, 1);
  });

  test('without proof the old execution ended, nothing is refreshed: unconfirmed and canceled stay refused', async () => {
    const lease = initialLease(source.id, target.id);
    const original = await runOriginalGeneration(lease);
    const key = actionSuccessorInvocationKeyForTarget(original.message.id, HOLDER);
    const real = records.getByIdempotencyKey(target.id, 'user-1', key);

    // No evidence anywhere is unconfirmed: the exact key finds nothing AND the persistent parent record that custody's
    // child lineage leads to is not there either. (Hiding only the key now would leave the lineage to confirm it.)
    const cases = {
      carrier_missing: { lookup: async () => null, hiddenRecordId: real.id },
      carrier_terminal: {
        lookup: async () => ({ ...real, status: 'canceled', successfulCatIds: [] }),
        recordById: (id) => (id === real.id ? { ...real, status: 'canceled', successfulCatIds: [] } : records.get(id)),
      },
    };
    for (const [reason, { lookup, hiddenRecordId, recordById }] of Object.entries(cases)) {
      const probe = Fastify();
      const previous = app;
      app = probe;
      await registerRoute({ executionRecord: lookup, hiddenRecordId, recordById });
      const response = await post(`refresh-4058-${reason}`);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(
        response.json().reason,
        reason,
        'inconsistent, absent or canceled canonical execution cannot refresh a carrier',
      );
      await probe.close();
      app = previous;
    }
    assert.equal(leaseStore.current.generation, 1);
    assert.equal(starts.length, 1);
    assert.deepEqual(queue.list(target.id, 'user-1'), []);
  });

  test('default off: without the lease-store option a handled carrier keeps its old refusal', async () => {
    const lease = initialLease(source.id, target.id);
    await runOriginalGeneration(lease);
    await registerRoute({ withLeaseStore: false });

    const response = await post('refresh-4058-off');

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().reason, 'carrier_terminal');
    assert.equal(leaseStore.current.generation, 1);
    assert.equal(starts.length, 1);
  });

  describe('the lease moved between the recognition and the commit', () => {
    test('a real holder cancellation that lands first is refused as lease_changed, never safe_wait', async () => {
      const lease = initialLease(source.id, target.id);
      await runOriginalGeneration(lease);
      await registerRoute();
      leaseStore.observed = lease; // this request recognised the pre-cancellation lease
      leaseStore.install(
        recordActionSuccessorOutcome(lease, {
          generation: lease.generation,
          catId: HOLDER,
          outcome: 'canceled',
          evidenceRef: 'test:concurrent-cancel',
          now: Date.now(),
        }),
      );

      const response = await post('refresh-4058-cancel-race');

      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().status, 'action_carrier_unavailable');
      assert.equal(response.json().reason, 'lease_changed');
      assert.equal(leaseStore.current.generation, 1);
      assert.equal(starts.length, 1);
      assert.deepEqual(queue.list(target.id, 'user-1'), []);
    });
  });
});
