import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { FreshnessOutputCommitCoordinator, SUPPLEMENT_DECLINE_MARKER } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js'
);
const { getFreshnessGlassBoxTelemetrySnapshot, resetFreshnessGlassBoxTelemetryForTest } = await import(
  '../dist/domains/cats/services/freshness/glass-box/freshness-glass-box-telemetry.js'
);

const scope = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

function draft(content = 'draft') {
  return {
    userId: scope.userId,
    catId: scope.catId,
    content,
    mentions: [],
    timestamp: 200,
    threadId: scope.threadId,
    origin: 'stream',
  };
}

function stale(messageId) {
  return {
    stale: true,
    unseenCount: 1,
    unseenSenders: ['user'],
    unseenMessageIds: [messageId],
    seenCursor: 'msg-before',
    highWatermark: messageId,
    observedRawFrontierMessageId: messageId,
    scanComplete: true,
    reason: 'unseen_messages',
  };
}

function fresh(seenCursor) {
  return {
    stale: false,
    unseenCount: 0,
    unseenSenders: [],
    unseenMessageIds: [],
    seenCursor,
    observedRawFrontierMessageId: seenCursor ?? undefined,
    scanComplete: true,
    reason: 'no_unseen',
  };
}

describe('F254 ADR-042 — glass-box output commit', () => {
  it('publishes a known-stale original, annotates its exact boundary, and offers seq 1', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [scope.catId],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original',
      message: draft('completed answer must remain visible'),
      replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
      evaluateFreshness: async (priorFrontierMessageId) => {
        assert.equal(priorFrontierMessageId, unseen.id);
        return { freshness: stale(unseen.id), rawFrontierMessageId: priorFrontierMessageId };
      },
    });

    assert.equal(decision.kind, 'published_with_unseen');
    assert.equal(decision.turnOutcome, 'committed');
    assert.equal(decision.lineageId, decision.messageId);
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'completed answer must remain visible');
    assert.deepEqual(published.extra?.freshness, {
      kind: 'published_with_unseen',
      priorFrontierMessageId: unseen.id,
      generatedWithUnseen: [unseen.id],
      lineageId: published.id,
    });
    const supplements = await closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplements.length, 1);
    assert.equal(supplements[0].id, decision.offeredSupplementId);
    assert.equal(supplements[0].status, 'pending');
    assert.deepEqual(supplements[0].replayUnsafeToolNames, ['mcp__cat-cafe-collab__cat_cafe_hold_ball']);
  });

  it('publishes the completed original but leaves ordinary queued work solely owned by Queue', async () => {
    const messageStore = new MessageStore();
    const queued = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'queued update',
      mentions: [scope.catId],
      timestamp: 150,
      threadId: scope.threadId,
      deliveryStatus: 'queued',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-queue-owned',
      message: draft('completed answer remains visible'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: {
          ...stale(queued.id),
          reason: 'queued_messages',
        },
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.turnOutcome, 'committed');
    assert.equal(decision.kind, 'committed_fresh');
    assert.equal((await messageStore.getById(decision.messageId)).content, 'completed answer remains visible');
    assert.equal((await messageStore.getById(queued.id)).deliveryStatus, 'queued');
    assert.deepEqual(await closureStore.listSupplementsByLineage(decision.messageId), []);
    const originals = (await messageStore.getByThread(scope.threadId)).filter(
      (message) => message.catId === scope.catId,
    );
    assert.equal(originals.length, 1, 'Queue ownership must not create a second supplement carrier');
  });

  it('publishes first and records freshness_unknown when the exact scan throws', async () => {
    const messageStore = new MessageStore();
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-unknown',
      message: draft('available even when the scanner is down'),
      evaluateFreshness: async () => {
        throw new Error('scanner unavailable');
      },
    });

    assert.equal(decision.kind, 'committed_degraded_unknown');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'available even when the scanner is down');
    assert.deepEqual(published.extra?.freshness, {
      kind: 'freshness_unknown',
      priorFrontierMessageId: null,
      reason: 'error_failopen',
    });
  });

  it('keeps a durably published original deliverable when legacy closure finalization throws', async () => {
    const messageStore = new MessageStore();
    const closureStore = new InMemoryFreshnessClosureStore();
    closureStore.get = async () => {
      throw new Error('legacy closure store unavailable');
    };
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-legacy-finalize-degraded',
      freshnessClosureId: 'legacy-closure',
      message: draft('published even when legacy cleanup is unavailable'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_fresh');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'published even when legacy cleanup is unavailable');
  });

  it('retries a transient annotation write without republishing the answer', async () => {
    const messageStore = new MessageStore();
    const updateExtra = messageStore.updateExtra.bind(messageStore);
    let annotationAttempts = 0;
    messageStore.updateExtra = async (...args) => {
      annotationAttempts += 1;
      if (annotationAttempts === 1) throw new Error('transient metadata write failure');
      return updateExtra(...args);
    };
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-annotation-retry',
      message: draft('publish exactly once across metadata retry'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_fresh');
    assert.equal(annotationAttempts, 2);
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].extra?.freshness?.kind, 'fresh');
  });

  it('keeps the published original deliverable when annotation persistence remains unavailable', async () => {
    const messageStore = new MessageStore();
    messageStore.updateExtra = async () => {
      throw new Error('metadata store unavailable');
    };
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-annotation-degraded',
      message: draft('the answer survives metadata failure'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_degraded_unknown');
    assert.equal(decision.reason, 'annotation_persistence_failed');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'the answer survives metadata failure');
    assert.equal(published.extra?.freshness?.kind, 'scan_pending');
  });

  it('does not claim published_with_unseen when the successful offer annotation cannot persist', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [scope.catId],
      timestamp: 150,
      threadId: scope.threadId,
    });
    messageStore.updateExtra = async () => {
      throw new Error('metadata store unavailable');
    };
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-offer-annotation-degraded',
      message: draft('published before annotation failure'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_degraded_unknown');
    assert.equal(decision.reason, 'annotation_persistence_failed');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'published before annotation failure');
    assert.equal(published.extra?.freshness?.kind, 'scan_pending');
    const supplements = await closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplements.length, 1, 'durable supplement responsibility must survive metadata degradation');
    assert.equal(supplements[0].status, 'pending');
  });

  it('marks the published original when supplement responsibility cannot be persisted', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [scope.catId],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    closureStore.offerSupplement = async () => {
      throw new Error('supplement store unavailable');
    };
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-offer-failed',
      message: draft('published before supplement offer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_degraded_unknown');
    assert.equal(decision.reason, 'supplement_offer_failed');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'published before supplement offer');
    assert.deepEqual(published.extra?.freshness, {
      kind: 'published_with_unseen',
      priorFrontierMessageId: unseen.id,
      generatedWithUnseen: [unseen.id],
      lineageId: published.id,
      supplementFailureReason: 'infrastructure',
    });
  });

  it('keeps the atomic pre-append frontier when another message arrives during the scan', async () => {
    const messageStore = new MessageStore();
    const trigger = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'question',
      mentions: [scope.catId],
      timestamp: 100,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-race',
      message: draft('answer linearized before later facts'),
      evaluateFreshness: async (priorFrontierMessageId) => {
        assert.equal(priorFrontierMessageId, trigger.id);
        await messageStore.append({
          userId: scope.userId,
          catId: null,
          content: 'arrived after publication',
          mentions: [scope.catId],
          timestamp: 250,
          threadId: scope.threadId,
        });
        return { freshness: fresh(trigger.id), rawFrontierMessageId: priorFrontierMessageId };
      },
    });

    assert.equal(decision.kind, 'committed_fresh');
    const published = await messageStore.getById(decision.messageId);
    assert.deepEqual(published.extra?.freshness, {
      kind: 'fresh',
      priorFrontierMessageId: trigger.id,
    });
  });

  it('idempotent retry reuses the published message and original observation boundary', async () => {
    const messageStore = new MessageStore();
    const frontier = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'question',
      mentions: [],
      timestamp: 100,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const input = {
      ...scope,
      invocationId: 'inv-idempotent',
      message: draft('publish once'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    };

    const first = await coordinator.commit(input);
    const second = await coordinator.commit(input);

    assert.equal(first.messageId, second.messageId);
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0].extra?.freshness, {
      kind: 'fresh',
      priorFrontierMessageId: frontier.id,
    });
  });

  it('persists checked_no_supplement_needed without creating an empty bubble', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const original = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original',
      message: draft('original answer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });
    const claimed = await closureStore.claimSupplement(original.offeredSupplementId, {
      invocationId: 'inv-supplement',
      now: 300,
    });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-supplement',
      freshnessSupplementId: claimed.id,
      message: draft(SUPPLEMENT_DECLINE_MARKER),
      evaluateFreshness: async () => {
        throw new Error('decline must not scan or append');
      },
    });

    assert.equal(decision.kind, 'supplement_declined');
    assert.equal((await closureStore.getSupplement(claimed.id)).status, 'declined');
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.deepEqual(
      answers.map((message) => message.content),
      ['original answer'],
    );
  });

  it('fails closed when a routing hook appends prose after the internal decline marker', async () => {
    resetFreshnessGlassBoxTelemetryForTest();
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const original = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original-protocol-recovery',
      message: draft('original answer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });
    const claimed = await closureStore.claimSupplement(original.offeredSupplementId, {
      invocationId: 'inv-supplement-protocol-recovery',
      now: 300,
    });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-supplement-protocol-recovery',
      freshnessSupplementId: claimed.id,
      message: draft(`${SUPPLEMENT_DECLINE_MARKER}\n\nStop hook feedback must stay internal.`),
      evaluateFreshness: async () => {
        throw new Error('recovered decline must not scan or append');
      },
    });

    assert.equal(decision.kind, 'supplement_declined');
    assert.equal((await closureStore.getSupplement(claimed.id)).status, 'declined');
    const answers = (await messageStore.getByThread(scope.threadId)).filter((message) => message.catId === scope.catId);
    assert.deepEqual(
      answers.map((message) => message.content),
      ['original answer'],
    );
    assert.equal(getFreshnessGlassBoxTelemetrySnapshot().supplement_decline_protocol_recovered, 1);
  });

  it('commits a supplement as a current-timestamp reply linked to the original', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const original = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original',
      message: draft('original answer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });
    const claimed = await closureStore.claimSupplement(original.offeredSupplementId, {
      invocationId: 'inv-supplement',
      now: 300,
    });

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-supplement',
      freshnessSupplementId: claimed.id,
      message: draft('补充：新消息改变了一个细节。'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_fresh');
    const supplementMessage = await messageStore.getById(decision.messageId);
    assert.equal(supplementMessage.replyTo, original.messageId);
    assert.ok(supplementMessage.timestamp > 300);
    assert.deepEqual(supplementMessage.extra?.supplement, {
      lineageId: original.messageId,
      supplementId: claimed.id,
      seq: 1,
      originalMessageId: original.messageId,
    });
    const terminal = await closureStore.getSupplement(claimed.id);
    assert.equal(terminal.status, 'committed');
    assert.equal(terminal.committedMessageId, supplementMessage.id);
  });

  it('retries the supplement state transition after the reply body is already durable', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const original = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original-crash-window',
      message: draft('original answer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });
    const claimed = await closureStore.claimSupplement(original.offeredSupplementId, {
      invocationId: 'inv-supplement-crash-window',
      now: 300,
    });
    const commitSupplement = closureStore.commitSupplement.bind(closureStore);
    let stateCommitAttempts = 0;
    closureStore.commitSupplement = async (...args) => {
      stateCommitAttempts += 1;
      if (stateCommitAttempts === 1) throw new Error('crash window');
      return commitSupplement(...args);
    };

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-supplement-crash-window',
      freshnessSupplementId: claimed.id,
      message: draft('durable before aggregate transition'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: fresh(priorFrontierMessageId),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });

    assert.equal(decision.kind, 'committed_fresh');
    assert.equal(stateCommitAttempts, 2);
    const messages = (await messageStore.getByThread(scope.threadId)).filter(
      (message) => message.content === 'durable before aggregate transition',
    );
    assert.equal(messages.length, 1);
    assert.equal((await closureStore.getSupplement(claimed.id)).status, 'committed');
  });

  it('returns a deliverable degraded decision if supplement state persistence remains unavailable', async () => {
    const messageStore = new MessageStore();
    const unseen = await messageStore.append({
      userId: scope.userId,
      catId: null,
      content: 'late correction',
      mentions: [],
      timestamp: 150,
      threadId: scope.threadId,
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const original = await coordinator.commit({
      ...scope,
      invocationId: 'inv-original-persistent-window',
      message: draft('original answer'),
      evaluateFreshness: async (priorFrontierMessageId) => ({
        freshness: stale(unseen.id),
        rawFrontierMessageId: priorFrontierMessageId,
      }),
    });
    const claimed = await closureStore.claimSupplement(original.offeredSupplementId, {
      invocationId: 'inv-supplement-persistent-window',
      now: 300,
    });
    closureStore.commitSupplement = async () => {
      throw new Error('supplement aggregate unavailable');
    };

    const decision = await coordinator.commit({
      ...scope,
      invocationId: 'inv-supplement-persistent-window',
      freshnessSupplementId: claimed.id,
      message: draft('must still be published'),
      evaluateFreshness: async () => {
        throw new Error('state failure stops follow-on scan');
      },
    });

    assert.equal(decision.kind, 'committed_degraded_unknown');
    assert.equal(decision.reason, 'supplement_state_commit_failed');
    const published = await messageStore.getById(decision.messageId);
    assert.equal(published.content, 'must still be published');
    assert.equal((await closureStore.getSupplement(claimed.id)).status, 'running');
  });
});
