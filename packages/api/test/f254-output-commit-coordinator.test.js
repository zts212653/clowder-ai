import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { FreshnessOutputCommitCoordinator } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js'
);

const scope = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

function draft(content = 'draft') {
  return canonicalTestMessageInput({
    userId: scope.userId,
    catId: scope.catId,
    content,
    mentions: [],
    timestamp: 200,
    threadId: scope.threadId,
    origin: 'stream',
  });
}

function question(content, timestamp) {
  return canonicalTestMessageInput({
    userId: scope.userId,
    catId: null,
    content,
    mentions: [scope.catId],
    timestamp,
    threadId: scope.threadId,
  });
}

describe('output commit — the storage-linearized exit of an answer turn', () => {
  it('publishes the completed answer and leaves queued work solely owned by Queue', async () => {
    const messageStore = new MessageStore();
    const queued = await messageStore.append(
      canonicalTestMessageInput({
        userId: scope.userId,
        catId: null,
        content: 'queued update',
        mentions: [scope.catId],
        timestamp: 150,
        threadId: scope.threadId,
        deliveryStatus: 'queued',
      }),
    );
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-queue-owned',
      message: draft('completed answer remains visible'),
    });

    assert.equal((await messageStore.getById(decision.messageId)).content, 'completed answer remains visible');
    assert.equal((await messageStore.getById(queued.id)).deliveryStatus, 'queued');
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.equal(answers.length, 1, 'queued input must not open a second carrier beside the answer');
  });

  it('records the exact pre-append frontier, and a later arrival does not move it', async () => {
    const messageStore = new MessageStore();
    const trigger = await messageStore.append(question('question', 100));
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-frontier',
      message: draft('answer linearized before later facts'),
    });
    await messageStore.append(question('arrived after publication', 250));

    const published = await messageStore.getById(decision.messageId);
    assert.deepEqual(published.extra?.freshness, { priorFrontierMessageId: trigger.id });
  });

  it('reports the turn identity that owns the published answer', async () => {
    const messageStore = new MessageStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-parent',
      turnInvocationId: 'inv-visible-turn',
      message: draft('answer'),
    });

    assert.equal(decision.turnInvocationId, 'inv-visible-turn');
  });

  it('idempotent retry reuses the published message and its original boundary', async () => {
    const messageStore = new MessageStore();
    const frontier = await messageStore.append(question('question', 100));
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore });
    const input = { ...scope, invocationId: 'inv-idempotent', message: draft('publish once') };

    const first = await coordinator.commit(input);
    const second = await coordinator.commit(input);

    assert.equal(first.messageId, second.messageId);
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0].extra?.freshness, { priorFrontierMessageId: frontier.id });
  });

  it('terminalizes the response row this turn already owns instead of appending a second bubble', async () => {
    const messageStore = new MessageStore();
    const trigger = await messageStore.append(question('question', 100));
    const processing = await messageStore.append(
      canonicalTestMessageInput({
        userId: scope.userId,
        catId: scope.catId,
        content: '',
        mentions: [],
        timestamp: 150,
        threadId: scope.threadId,
        origin: 'stream',
        idempotencyKey: 'message-lifecycle-response:inv-lifecycle',
        lifecycle: {
          kind: 'response',
          orderKey: '150:inv-lifecycle',
          invocationId: 'inv-lifecycle',
          targetId: scope.catId,
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'processing',
          startedAt: 150,
        },
      }),
    );
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-lifecycle',
      message: draft('the answer this turn produced'),
      lifecycleResponse: {
        messageId: processing.id,
        priorFrontierMessageId: trigger.id,
        status: 'completed',
        completedAt: 300,
      },
    });

    assert.equal(decision.messageId, processing.id, 'the pre-created response row is the answer');
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].content, 'the answer this turn produced');
  });
});
