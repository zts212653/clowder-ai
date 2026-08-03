import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { FreshnessOutputCommitCoordinator, SUPPLEMENT_DECLINE_MARKER } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js'
);

function textService(catId, content, options = {}) {
  return {
    supportsToolExecutionPolicy: () => true,
    async *invoke() {
      if (options.toolName) {
        yield {
          type: 'tool_use',
          catId,
          toolName: options.toolName,
          toolUseId: `${catId}-tool`,
          timestamp: Date.now(),
        };
      }
      yield { type: 'text', catId, content, timestamp: Date.now() };
      yield {
        type: 'done',
        catId,
        timestamp: Date.now(),
        ...(options.freshnessReinvoke ? { metadata: { freshnessReinvoke: options.freshnessReinvoke } } : {}),
      };
    },
  };
}

function thinkingService(catId, thinking) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: thinking }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps(services, messageStore = new MessageStore(), closureStore = new InMemoryFreshnessClosureStore()) {
  let invocationSeq = 0;
  return {
    deps: {
      services,
      invocationDeps: {
        registry: {
          create: () => ({
            invocationId: `inv-${++invocationSeq}`,
            callbackToken: `tok-${invocationSeq}`,
          }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: {
          get: async (threadId) => ({
            id: threadId,
            title: 'Test Thread',
            createdBy: 'user1',
            participants: [],
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            projectPath: 'default',
          }),
          getParticipantsWithActivity: async () => [],
          consumeMentionRoutingFeedback: async () => null,
          setMentionRoutingFeedback: async () => {},
          getVotingState: async () => null,
          updateVotingState: async () => {},
          updateParticipantActivity: async () => {},
        },
        apiUrl: 'http://127.0.0.1:3004',
      },
      messageStore,
      socketManager: { broadcastToRoom: () => {} },
    },
    messageStore,
    closureStore,
  };
}

function enableFreshness(harness, seenCursor) {
  harness.deps.deliveryCursorStore = {
    getCursor: async () => seenCursor,
    getSeenCursor: async () => seenCursor,
    ackCursor: async () => {},
    ackSeenCursor: async () => {},
  };
  harness.deps.freshnessOutputCommitCoordinator = new FreshnessOutputCommitCoordinator({
    messageStore: harness.messageStore,
    closureStore: harness.closureStore,
  });
}

async function drain(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('F254 ADR-042 — route-serial publish then supplement', () => {
  it('keeps the legacy terminal metadata wake only when no glass-box decision owns the turn', async () => {
    const enqueued = [];
    const harness = createDeps({
      opus: textService('opus', 'done', {
        freshnessReinvoke: {
          shouldReinvoke: true,
          reason: 'trigger:high_priority_unseen',
          noticeIds: ['notice-1'],
          senders: ['user'],
          reinvokePrompt: 'read current context',
        },
      }),
    });

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        ownerAuthProvenance: 'strict',
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].content, 'read current context');
    assert.equal(enqueued[0].ownerAuthProvenance, 'strict');
  });

  it('publishes a stale serial answer and enqueues a distinct read-only supplement carrier', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    const unseen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const harness = createDeps({ opus: textService('opus', 'completed answer') }, messageStore);
    enableFreshness(harness, seen.id);
    const enqueued = [];

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        parentInvocationId: 'turn-serial',
        ownerAuthProvenance: 'strict',
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'completed answer');
    assert.deepEqual(published.extra.freshness.generatedWithUnseen, [unseen.id]);
    const [supplement] = await harness.closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplement.status, 'pending');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].freshnessSupplementId, supplement.id);
    assert.equal(enqueued[0].freshnessClosureId, undefined);
    assert.equal(enqueued[0].ownerAuthProvenance, 'strict');
    assert.equal(enqueued[0].readOnlyToolPolicy.mode, 'read_only');
  });

  it('keeps the original and persists queue_full when the supplement carrier cannot enqueue', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const harness = createDeps({ opus: textService('opus', 'completed answer') }, messageStore);
    enableFreshness(harness, seen.id);

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        parentInvocationId: 'turn-queue-full',
        freshnessReinvokeEnqueue: () => ({ outcome: 'full' }),
      }),
    );

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'completed answer');
    const [supplement] = await harness.closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplement.status, 'failed');
    assert.equal(supplement.failureReason, 'queue_full');
  });

  it('keeps the original and persists scheduler_unavailable when no supplement scheduler is wired', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const harness = createDeps({ opus: textService('opus', 'completed answer') }, messageStore);
    enableFreshness(harness, seen.id);

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        parentInvocationId: 'turn-no-scheduler',
      }),
    );

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'completed answer');
    const [supplement] = await harness.closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplement.status, 'failed');
    assert.equal(supplement.failureReason, 'scheduler_unavailable');
  });

  it('publishes an answer-bearing thinking-only completion instead of replacing it with a placeholder', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const harness = createDeps({ opus: thinkingService('opus', 'visible reasoning result') }, messageStore);
    enableFreshness(harness, seen.id);
    const enqueued = [];

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        parentInvocationId: 'turn-thinking',
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.ok(published);
    assert.match(published.thinking, /visible reasoning result/);
    assert.equal(published.extra.freshness.kind, 'published_with_unseen');
    assert.equal(enqueued.length, 1);
  });

  it('publishes a side-effecting answer and carries replay-unsafe names into the hard supplement policy', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const toolName = 'mcp__cat-cafe-collab__cat_cafe_hold_ball';
    const harness = createDeps({ opus: textService('opus', 'action completed', { toolName }) }, messageStore);
    enableFreshness(harness, seen.id);
    const enqueued = [];

    await drain(
      routeSerial(harness.deps, ['opus'], 'question', 'user1', 'thread-1', {
        parentInvocationId: 'turn-tool',
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'action completed');
    assert.deepEqual(enqueued[0].readOnlyToolPolicy.replayDeniedToolNames, [toolName]);
  });

  it('persists a supplement decline without creating an empty or marker bubble', async () => {
    const messageStore = new MessageStore();
    const original = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'published original',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
      extra: { freshness: { kind: 'fresh', priorFrontierMessageId: null } },
    });
    const update = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'thanks',
      mentions: [],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const harness = createDeps({ opus: textService('opus', SUPPLEMENT_DECLINE_MARKER) }, messageStore);
    const offered = await harness.closureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'user1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: [update.id],
      requiredFrontierMessageId: update.id,
      now: 200,
    });
    await harness.closureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'turn-decline',
      now: 250,
    });
    enableFreshness(harness, update.id);

    await drain(
      routeSerial(harness.deps, ['opus'], 'supplement check', 'user1', 'thread-1', {
        parentInvocationId: 'turn-decline',
        freshnessSupplementId: offered.supplement.id,
        freshnessSupplementRequiredMessageIds: [update.id],
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      }),
    );

    assert.equal((await harness.closureStore.getSupplement(offered.supplement.id)).status, 'declined');
    const catMessages = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.deepEqual(
      catMessages.map((message) => message.content),
      ['published original'],
    );
  });

  it('stores supplement text as a reply but never dispatches route-like output', async () => {
    const messageStore = new MessageStore();
    const original = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'published original',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
      extra: { freshness: { kind: 'fresh', priorFrontierMessageId: null } },
    });
    const update = await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: 'thread-1',
    });
    let codexInvocations = 0;
    const harness = createDeps(
      {
        opus: textService('opus', '补充：一个细节有变化。\n@codex'),
        codex: {
          async *invoke() {
            codexInvocations += 1;
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      messageStore,
    );
    const offered = await harness.closureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'user1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: [update.id],
      requiredFrontierMessageId: update.id,
      now: 200,
    });
    await harness.closureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'turn-supplement',
      now: 250,
    });
    enableFreshness(harness, update.id);

    await drain(
      routeSerial(harness.deps, ['opus'], 'supplement check', 'user1', 'thread-1', {
        parentInvocationId: 'turn-supplement',
        freshnessSupplementId: offered.supplement.id,
        freshnessSupplementRequiredMessageIds: [update.id],
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      }),
    );

    assert.equal(codexInvocations, 0);
    const catMessages = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(catMessages.length, 2);
    assert.equal(catMessages[1].replyTo, original.id);
    assert.deepEqual(catMessages[1].mentions, []);
    assert.equal(catMessages[1].extra.supplement.supplementId, offered.supplement.id);
  });
});
