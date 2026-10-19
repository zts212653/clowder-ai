import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { cursorFor } from '../dist/domains/cats/services/stores/cursor.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

const noop = () => {};
const FIRST = 'REVIEW_FIRST_SOURCE_ONLY';
const SECOND = 'REVIEW_SECOND_SOURCE_ONLY';

// Real Queue → AgentRouter → context projection → invocation lifecycle. Only
// the provider is controlled; an explicit barrier holds the first receiver.
for (const topology of ['serial', 'parallel'])
  for (const [outcome, failureCarrier] of [
    ['completed', null],
    ['failed', null],
    ['failed', 'only'],
    ['failed', 'with ordinary caller'],
  ])
    for (const middle of topology === 'serial' && outcome === 'completed'
      ? [null, 'conversation_input', 'private_input']
      : [null]) {
      test(`${topology}/${outcome}/${failureCarrier ?? middle ?? 'adjacent'}: complete public A2A projection covers only eligible caller returns in one receiver`, async () => {
        const messages = new MessageStore();
        const threads = new ThreadStore();
        const thread = threads.create('owner', 'pending prompt delivery');
        const turns = new InMemoryTurnExecutionStore();
        const registry = new InvocationRegistry();
        const tracker = new InvocationTracker();
        const prompts = [];
        const firstStarted = Promise.withResolvers();
        const firstMayFinish = Promise.withResolvers();
        const service = {
          async *invoke(prompt) {
            prompts.push(prompt);
            if (prompts.length === 1) {
              firstStarted.resolve();
              await firstMayFinish.promise;
            }
            if (outcome === 'failed')
              yield {
                type: 'error',
                catId: 'opus',
                content: 'provider failed',
                error: 'provider failed',
                timestamp: Date.now(),
              };
            else yield { type: 'text', catId: 'opus', content: 'Review complete.', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        };
        const callerInvocations = [];
        const callerService = (catId) => ({
          async *invoke(prompt) {
            callerInvocations.push({ catId, prompt });
            yield { type: 'text', catId, content: 'Peer finished.', timestamp: Date.now() };
            yield { type: 'done', catId, timestamp: Date.now() };
          },
        });
        const router = new AgentRouter(
          await migrateRouterOpts({
            claudeService: service,
            codexService: callerService('codex'),
            geminiService: callerService('gemini'),
            registry,
            messageStore: messages,
            threadStore: threads,
            turnExecutionStore: turns,
          }),
        );
        const queue = new InvocationQueue(undefined, { invocationTracker: tracker });
        const processor = new QueueProcessor({
          queue,
          router,
          messageStore: messages,
          invocationTracker: tracker,
          invocationRecordStore: new InvocationRecordStore(),
          turnExecutionStore: turns,
          socketManager: { emitToUser: noop, broadcastToRoom: noop, broadcastAgentMessage: noop },
          log: { info: noop, warn: noop, error: noop },
        });
        const admit = (content, targets = ['opus'], callerCatId = 'codex', sourceCategory = 'a2a') =>
          queue.send(
            messages,
            {
              userId: 'owner',
              threadId: thread.id,
              from: { kind: 'agent', catId: callerCatId },
              content,
              mentions: targets,
              timestamp: Date.now(),
              idempotencyKey: content,
            },
            {
              kind: 'message_wake',
              userId: 'owner',
              threadId: thread.id,
              from: { kind: 'agent', catId: callerCatId },
              content,
              targetCats: targets,
              sourceCategory,
              ownerAuthProvenance: 'strict',
              intent: 'execute',
              autoExecute: true,
              messageDisposition: 'next_work',
            },
          );
        const first = await admit(
          FIRST,
          topology === 'parallel' ? ['opus', 'codex'] : ['opus'],
          'codex',
          failureCarrier ? 'a2a_failure' : 'a2a',
        );
        const hiddenBody = 'NOT_YET_ADMITTED_INPUT';
        const hidden =
          middle === 'conversation_input'
            ? await queue.send(
                messages,
                {
                  userId: 'owner',
                  threadId: thread.id,
                  from: { kind: 'user', userId: 'owner' },
                  content: hiddenBody,
                  mentions: ['opus'],
                  timestamp: Date.now(),
                  deliveryStatus: 'queued',
                },
                {
                  userId: 'owner',
                  threadId: thread.id,
                  from: { kind: 'user', userId: 'owner' },
                  content: hiddenBody,
                  targetCats: ['opus'],
                  kind: middle,
                  ownerAuthProvenance: 'strict',
                  intent: 'execute',
                  autoExecute: true,
                  messageDisposition: 'next_work',
                },
              )
            : middle === 'private_input'
              ? await queue.enqueueDurable({
                  userId: 'owner',
                  threadId: thread.id,
                  sourceId: 'private-between-wakes',
                  from: { kind: 'system', service: 'fixture' },
                  content: hiddenBody,
                  targetCats: ['opus'],
                  kind: middle,
                  ownerAuthProvenance: 'strict',
                  intent: 'execute',
                  autoExecute: true,
                })
              : undefined;
        const second = failureCarrier === 'only' ? undefined : await admit(SECOND, ['opus'], 'gemini');
        const sources = [first.message, ...(second ? [second.message] : [])];
        const inputIds = sources.map((source) => source.id);
        const drain = processor.requestDrain(thread.id);
        try {
          await firstStarted.promise;
          assert.match(prompts[0], new RegExp(FIRST));
          assert.equal(
            prompts[0].includes(SECOND),
            Boolean(second),
            'the prompt contains exactly the actual ordinary public source when present',
          );
          const firstResponseId = messages
            .getById(first.message.id)
            .lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').statusMessageId;
          for (const source of sources) {
            const refs = messages.getById(source.id).lifecycle.dispatchRefs.filter((ref) => ref.targetId === 'opus');
            assert.equal(refs.length, 1);
            assert.equal(refs[0].statusMessageId, firstResponseId);
          }
          const response = messages.getById(firstResponseId);
          assert.deepEqual(new Set(response.lifecycle.inputMessageIds), new Set(inputIds));
          const active = tracker.getActiveSlots(thread.id).find((slot) => slot.catId === 'opus').activeRun;
          assert.deepEqual(new Set(active.inputMessageIds), new Set(response.lifecycle.inputMessageIds));
          assert.ok(!prompts[0].includes(hiddenBody), 'unpublished input cannot enter the first public projection');
          assert.ok(
            queue.list(thread.id, 'owner').every((row) => row.id === hidden?.entry.id || !row.targets.includes('opus')),
          );
          if (hidden) assert.deepEqual((await queue.getDurableEntry(thread.id, hidden.entry.id)).targets, ['opus']);
          firstMayFinish.resolve();
          await drain;
          const deadline = Date.now() + 5000;
          while (
            (tracker.getActiveSlots(thread.id).length || queue.list(thread.id, 'owner').length) &&
            Date.now() < deadline
          )
            await delay(5);
          assert.equal(messages.getById(firstResponseId).lifecycle.status, outcome);
          assert.equal(
            prompts.length,
            hidden ? 2 : 1,
            'public wakes share one receiver; an unpublished input waits for its own admission',
          );
          if (hidden) assert.ok(prompts[1].includes(hiddenBody));
          for (const source of sources) {
            const refs = messages.getById(source.id).lifecycle.dispatchRefs.filter((ref) => ref.targetId === 'opus');
            assert.equal(refs.length, 1);
            const response = messages.getById(refs[0].statusMessageId);
            assert.deepEqual(new Set(response.lifecycle.inputMessageIds), new Set(inputIds));
            assert.equal(refs[0].phase, 'settled');
          }
          assert.equal(queue.list(thread.id, 'owner').length, 0);
          assert.equal(tracker.getActiveSlots(thread.id).length, 0);
          if (outcome === 'failed') {
            const failureRefs = messages.getById(firstResponseId).lifecycle.dispatchRefs ?? [];
            const expectedCallers = [...(failureCarrier ? [] : ['codex']), ...(second ? ['gemini'] : [])];
            assert.deepEqual(
              new Set(failureRefs.map((ref) => ref.targetId)),
              new Set(expectedCallers),
              'a failed report carrier never bounces to its reporter; covered ordinary callers still receive it',
            );
            assert.ok(failureRefs.every((ref) => ref.phase === 'settled'));
            for (const ref of failureRefs)
              assert.ok(messages.getById(ref.statusMessageId).lifecycle.inputMessageIds.includes(firstResponseId));
            assert.equal(callerInvocations.filter((call) => call.catId === 'gemini').length, second ? 1 : 0);
            assert.equal(
              callerInvocations.filter((call) => call.catId === 'codex').length,
              (topology === 'parallel' ? 1 : 0) + (failureCarrier ? 0 : 1),
            );
          }
        } finally {
          firstMayFinish.resolve();
          await drain;
        }
      });
    }

for (const contextMode of ['hot', 'cold']) {
  test(`${contextMode}: pending public speech participates in the actual projection and reply previews`, async () => {
    const messages = new MessageStore();
    const append = (content, extra = {}) =>
      messages.append({
        userId: 'owner',
        threadId: 'prompt-visibility',
        from: { kind: 'agent', catId: 'codex' },
        content,
        mentions: ['opus'],
        timestamp: Date.now(),
        ...extra,
      });
    const first = append(FIRST);
    const second = append(SECOND);
    const third = append('A visible reference whose pending parent is not delivered yet.', {
      replyTo: second.id,
      mentions: [],
    });
    const deliveryCursorStore = new DeliveryCursorStore();
    const deps = { messageStore: messages, deliveryCursorStore, invocationDeps: {} };
    const options = {
      effectiveMaxContextTokens: 10000,
      resolvePendingWakeMessageIds: async () => [second.id],
      contextProjection: {
        coordinate: {
          providerCarrier: { provider: 'codex', carrier: 'exec_json' },
          invocationOrigin: 'interactive',
          routeTopology: 'serial',
        },
        contextEpoch: 1,
        contextMode,
        transition: 'scope_first_seen',
        reason: 'no_prior_session',
      },
    };
    const projection = await assembleIncrementalContext(
      deps,
      'owner',
      'prompt-visibility',
      'opus',
      first.id,
      'play',
      options,
    );
    assert.ok(projection.exposedMessageIds.includes(first.id));
    assert.ok(projection.exposedMessageIds.includes(second.id));
    assert.match(projection.contextText, new RegExp(SECOND));
    assert.ok(!projection.projectionAudit.messageRefs.some((item) => item.reason === 'pending_delivery'));
    assert.equal(
      projection.boundaryId,
      cursorFor(third),
      'the actual complete projection may acknowledge the public tail',
    );
    assert.match(projection.contextText, new RegExp(`\\[↩[^\\n]*${SECOND}`));
  });
}

// Recovery is a second cursor writer: a valid proof beyond a pending gap must
// not consume that gap, even when it is the very first unseen message.
for (const pendingPosition of ['middle', 'first', 'after-cursor']) {
  test(`delivery recovery preserves a pending gap at ${pendingPosition}`, async () => {
    const messages = new MessageStore();
    const cursors = new DeliveryCursorStore();
    const threadId = 'pending-recovery';
    const append = (content, extra = {}) =>
      messages.append({
        userId: 'owner',
        threadId,
        from: { kind: 'agent', catId: 'codex' },
        content,
        mentions: ['opus'],
        timestamp: Date.now(),
        ...extra,
      });
    const first = pendingPosition === 'first' ? undefined : append(FIRST);
    if (pendingPosition === 'after-cursor') await cursors.ackCursor('owner', 'opus', threadId, cursorFor(first));
    const pending = append(SECOND);
    const later = append('Later source with a valid delivery proof');
    append('Completed later source', {
      from: { kind: 'agent', catId: 'opus' },
      origin: 'stream',
      mentions: [],
      extra: {
        stream: { invocationId: 'parent', turnInvocationId: 'child' },
        causal: { kind: 'invocation_reply', triggerMessageId: later.id },
        deliveryBoundary: {
          v: 1,
          userId: 'owner',
          threadId,
          catId: 'opus',
          turnInvocationId: 'child',
          sourceMessageId: later.id,
          cursor: cursorFor(later),
        },
      },
    });
    const deps = { messageStore: messages, deliveryCursorStore: cursors, invocationDeps: {} };
    const projection = await assembleIncrementalContext(deps, 'owner', threadId, 'opus', first?.id, 'play', {
      effectiveMaxContextTokens: 10000,
      resolvePendingWakeMessageIds: async () => [pending.id],
    });
    const previousCursor = pendingPosition === 'after-cursor' ? cursorFor(first) : undefined;
    assert.equal(
      await cursors.getCursor('owner', 'opus', threadId),
      previousCursor,
      'recovery must not acknowledge a proven later source across the gap',
    );
    assert.equal(
      projection.boundaryId,
      cursorFor(later),
      'the complete prompt can cover the gap after recovery leaves it unread',
    );
  });
}
