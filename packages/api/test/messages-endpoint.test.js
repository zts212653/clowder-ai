/**
 * GET /api/messages endpoint tests
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

describe('GET /api/messages', () => {
  let app;
  let messageStore;
  let freshnessClosureStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    const { InMemoryFreshnessClosureStore } = await import(
      '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
    );

    messageStore = new MessageStore();
    freshnessClosureStore = new InMemoryFreshnessClosureStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      freshnessClosureStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns empty array when no messages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.deepEqual(body.messages, []);
    assert.equal(body.hasMore, false);
  });

  it('returns messages with correct format', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'hello',
      mentions: ['opus'],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'hi there',
      mentions: [],
      timestamp: 2000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 2);

    // User message
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].catId, null);
    assert.equal(body.messages[0].content, 'hello');

    // Assistant message
    assert.equal(body.messages[1].type, 'assistant');
    assert.equal(body.messages[1].catId, 'opus');
    assert.equal(body.messages[1].content, 'hi there');
  });

  it('renders an authored queued cat seed without exposing queued user or system work', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'ordinary queued user work',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread-f128-seed',
      deliveryStatus: 'queued',
    });
    messageStore.append({
      userId: 'system',
      catId: 'system',
      content: 'queued internal system work',
      mentions: [],
      timestamp: 1050,
      threadId: 'thread-f128-seed',
      deliveryStatus: 'queued',
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'codex-sol',
      content: 'source-cat thread seed',
      mentions: ['opus'],
      timestamp: 1100,
      threadId: 'thread-f128-seed',
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-f128-seed',
        intent: 'execute',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: 1100,
        updatedAt: 1100,
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-f128-seed' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'assistant');
    assert.equal(body.messages[0].catId, 'codex-sol');
    assert.equal(body.messages[0].content, 'source-cat thread seed');
  });

  it('F264 publishes a steered user message in place without making it prompt-delivered', async () => {
    const steered = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'steered follow-up stays visible while the replacement runs',
      mentions: ['opus'],
      timestamp: 1200,
      threadId: 'thread-steer-publication',
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-steer-publication',
        status: 'queued',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        steerRequestedByCatIds: ['opus'],
        createdAt: 1200,
        updatedAt: 1250,
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-steer-publication' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].id, steered.id);
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].timestamp, 1200);
    assert.equal(body.messages[0].deliveredAt, undefined);
    assert.deepEqual(body.messages[0].extra.queueReceipt.targets, [{ catId: 'opus', state: 'steering' }]);
    assert.equal(messageStore.getById(steered.id).deliveryStatus, 'queued');
  });

  it('F264 publishes untouched durable queued user work with its unread receipt', async () => {
    const queued = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'queued follow-up remains at its authored timeline position',
      mentions: ['opus'],
      timestamp: 1300,
      threadId: 'thread-queued-publication',
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-queued-publication',
        status: 'queued',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: 1300,
        updatedAt: 1300,
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-queued-publication' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].id, queued.id);
    assert.equal(body.messages[0].deliveredAt, undefined);
    assert.deepEqual(body.messages[0].extra.queueReceipt.targets, [{ catId: 'opus', state: 'queued' }]);
  });

  it('F264 keeps canceled queued user work out of browser history after F5', async () => {
    const canceled = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'withdrawn follow-up must not reappear',
      mentions: ['opus'],
      timestamp: 1350,
      threadId: 'thread-canceled-publication',
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-canceled-publication',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: 1350,
        updatedAt: 1350,
      }),
    });
    messageStore.markCanceled(canceled.id);

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-canceled-publication' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 0);
  });

  it('returns separate delivery and timeline-order timestamps for terminal published cat speech', async () => {
    const speech = messageStore.append({
      userId: 'default-user',
      catId: 'codex-sol',
      content: 'published before recipient execution finishes',
      mentions: ['opus'],
      timestamp: 1100,
      threadId: 'thread-published-order',
      deliveryStatus: 'queued',
    });
    messageStore.markDelivered(speech.id, 1500);

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-published-order' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages[0].deliveredAt, 1500);
    assert.equal(body.messages[0].timelineOrderAt, 1100);
  });

  it('preserves explicit post flag with stream identity in history response', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'standalone post',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-explicit',
      extra: {
        isExplicitPost: true,
        stream: { invocationId: 'inv-parent', turnInvocationId: 'turn-explicit' },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-explicit' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].extra?.isExplicitPost, true);
    assert.deepEqual(body.messages[0].extra?.stream, {
      invocationId: 'inv-parent',
      turnInvocationId: 'turn-explicit',
    });
  });

  it('F264 hydrates a terminal receipt at the original user-message position', async () => {
    const queued = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'message sent during the turn',
      mentions: ['opus'],
      timestamp: 1500,
      threadId: 'thread-receipt',
      deliveryStatus: 'queued',
      queueCustody: makeQueuedMessageCustody({
        entryId: 'entry-receipt',
        intent: 'execute',
        status: 'processing',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'inv-receipt' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-receipt', seenAt: 1600 }],
        processingStartedAt: 1550,
        createdAt: 1500,
        updatedAt: 1550,
      }),
    });
    await messageStore.transitionQueueCustody(queued.id, {
      expectedRevision: 1,
      deliveredAt: 1700,
      next: {
        ...queued.queueCustody,
        revision: 2,
        status: 'terminal',
        pendingTargetCats: [],
        seenInvocationIdByCatId: {},
        handledByCatIds: ['opus'],
        targetOutcomeByCatId: {
          opus: {
            invocationId: 'inv-receipt',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-receipt' },
            handledAt: 1700,
          },
        },
        updatedAt: 1700,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-receipt' });
    const body = JSON.parse(res.body);

    assert.deepEqual(body.messages[0].extra.queueReceipt, {
      version: 1,
      entryId: 'entry-receipt',
      targets: [
        {
          catId: 'opus',
          state: 'handled',
          invocationId: 'inv-receipt',
          seenAt: 1600,
          outcome: {
            invocationId: 'inv-receipt',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-receipt' },
            handledAt: 1700,
          },
        },
      ],
      reminderAttempts: [],
    });
    assert.equal(body.messages[0].deliveredAt, 1700);
    assert.equal(body.messages[0].timelineOrderAt, 1500);
  });

  it('ADR-042 hydrates original freshness and supplement reply provenance', async () => {
    const original = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'published original',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-supplement',
      extra: {
        turnExecution: {
          invocationId: 'child-ordinary-1',
          parentInvocationId: 'parent-supplement-1',
          executionKind: 'ordinary',
        },
        auxiliaryTurnExecutions: [
          {
            invocationId: 'child-routing-guard-1',
            parentInvocationId: 'parent-supplement-1',
            executionKind: 'routing_guard',
          },
        ],
        freshness: {
          kind: 'published_with_unseen',
          priorFrontierMessageId: 'msg-late',
          generatedWithUnseen: ['msg-late'],
          lineageId: 'temporary',
        },
      },
    });
    messageStore.updateExtra(original.id, {
      freshness: {
        kind: 'published_with_unseen',
        priorFrontierMessageId: 'msg-late',
        generatedWithUnseen: ['msg-late'],
        lineageId: original.id,
      },
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'additive supplement',
      mentions: [],
      timestamp: 3000,
      threadId: 'thread-supplement',
      replyTo: original.id,
      extra: {
        freshness: { kind: 'fresh', priorFrontierMessageId: original.id },
        turnExecution: {
          invocationId: 'child-supplement-1',
          parentInvocationId: 'parent-supplement-1',
          executionKind: 'freshness_supplement',
        },
        supplement: {
          lineageId: original.id,
          supplementId: `f254-supplement:${original.id}:1`,
          seq: 1,
          originalMessageId: original.id,
        },
      },
    });
    const offered = await freshnessClosureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'default-user',
      threadId: 'thread-supplement',
      catId: 'opus',
      requiredMessageIds: ['msg-late'],
      requiredFrontierMessageId: 'msg-late',
      replayUnsafeToolNames: [],
      now: 2100,
    });
    await freshnessClosureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'inv-supplement-check',
      now: 2200,
    });
    await freshnessClosureStore.declineSupplement(offered.supplement.id, {
      invocationId: 'inv-supplement-check',
      now: 2300,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-supplement' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].extra.freshness.kind, 'published_with_unseen');
    assert.deepEqual(body.messages[0].extra.turnExecution, {
      invocationId: 'child-ordinary-1',
      parentInvocationId: 'parent-supplement-1',
      executionKind: 'ordinary',
    });
    assert.deepEqual(body.messages[0].extra.auxiliaryTurnExecutions, [
      {
        invocationId: 'child-routing-guard-1',
        parentInvocationId: 'parent-supplement-1',
        executionKind: 'routing_guard',
      },
    ]);
    assert.deepEqual(body.messages[0].extra.freshnessSupplement, {
      type: 'freshness_supplement',
      supplementId: offered.supplement.id,
      lineageId: original.id,
      originalMessageId: original.id,
      threadId: 'thread-supplement',
      catId: 'opus',
      seq: 1,
      status: 'declined',
      requiredCount: 1,
      terminalReason: 'checked_no_supplement_needed',
      updatedAt: 2300,
    });
    assert.deepEqual(body.messages[1].extra.supplement, {
      lineageId: original.id,
      supplementId: `f254-supplement:${original.id}:1`,
      seq: 1,
      originalMessageId: original.id,
    });
    assert.deepEqual(body.messages[1].extra.turnExecution, {
      invocationId: 'child-supplement-1',
      parentInvocationId: 'parent-supplement-1',
      executionKind: 'freshness_supplement',
    });
    assert.equal(body.messages[1].replyTo, original.id);
    assert.equal(body.messages[1].replyPreview.content, 'published original');
  });

  it('ADR-042 repairs a historically committed decline control output during hydration', async () => {
    const original = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'published original before protocol repair',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-supplement-control-recovery',
    });
    const offered = await freshnessClosureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'default-user',
      threadId: 'thread-supplement-control-recovery',
      catId: 'opus',
      requiredMessageIds: ['msg-late'],
      requiredFrontierMessageId: 'msg-late',
      replayUnsafeToolNames: [],
      now: 2100,
    });
    const claimed = await freshnessClosureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'inv-supplement-control-recovery',
      now: 2200,
    });
    const leaked = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: '<!-- cat-cafe:supplement-decline -->\n\nStop hook feedback must stay internal.',
      mentions: [],
      timestamp: 2300,
      threadId: 'thread-supplement-control-recovery',
      replyTo: original.id,
      extra: {
        supplement: {
          lineageId: original.id,
          supplementId: claimed.id,
          seq: 1,
          originalMessageId: original.id,
        },
      },
    });
    await freshnessClosureStore.commitSupplement(claimed.id, {
      invocationId: 'inv-supplement-control-recovery',
      messageId: leaked.id,
      now: 2400,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-supplement-control-recovery',
    });
    const body = JSON.parse(res.body);

    assert.deepEqual(
      body.messages.map((message) => message.id),
      [original.id],
    );
    assert.deepEqual(body.messages[0].extra.freshnessSupplement, {
      type: 'freshness_supplement',
      supplementId: claimed.id,
      lineageId: original.id,
      originalMessageId: original.id,
      threadId: 'thread-supplement-control-recovery',
      catId: 'opus',
      seq: 1,
      status: 'declined',
      requiredCount: 1,
      terminalReason: 'checked_no_supplement_needed',
      updatedAt: 2400,
    });
  });

  it('projects only browser-safe F254 recovery metadata in history response', async () => {
    const recovery = {
      kind: 'f254_withheld_message',
      invocationId: 'inv-recovery-1',
      manifestSha256: 'a'.repeat(64),
      contentSha256: 'b'.repeat(64),
      cvoDecisionRef: '0001783820437069-000027-a6cebcce',
      recoveredAt: 3000,
      sourceProof: {
        transcriptPath: 'data/transcripts/thread_recovery/fable-5/events.jsonl',
        sessionId: 'session-1',
        firstEventNo: 1,
        lastEventNo: 4,
        terminalEventNo: 4,
        terminalKind: 'transcript_done',
      },
    };
    messageStore.append({
      userId: 'default-user',
      catId: 'fable-5',
      content: '买到了，正在回家。',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-recovery',
      extra: {
        stream: { invocationId: 'inv-recovery-1', turnInvocationId: 'inv-recovery-1' },
        recovery,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-recovery' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.deepEqual(body.messages[0].extra?.recovery, {
      kind: 'f254_withheld_message',
      cvoDecisionRef: '0001783820437069-000027-a6cebcce',
      recoveredAt: 3000,
    });
    assert.equal(body.messages[0].extra?.recovery?.invocationId, undefined);
    assert.equal(body.messages[0].extra?.recovery?.manifestSha256, undefined);
    assert.equal(body.messages[0].extra?.recovery?.contentSha256, undefined);
    assert.equal(body.messages[0].extra?.recovery?.sourceProof, undefined);
  });

  it('maps canonical system messages to type=system', async () => {
    messageStore.append({
      userId: 'system',
      catId: 'system',
      content: '🐺 狼人请睁眼',
      mentions: [],
      timestamp: 1000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'system');
    assert.equal(body.messages[0].catId, 'system');
  });

  it('returns persisted system error messages with catId=null as type=system', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'ping gemini',
      mentions: ['gemini'],
      timestamp: 1000,
      threadId: 'thread-1',
    });
    messageStore.append({
      userId: 'system',
      catId: null,
      content: 'Error: stream_idle_stall: Gemini stopped responding',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-1' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].type, 'system');
    assert.equal(body.messages[1].catId, null);
    assert.match(body.messages[1].content, /^Error: stream_idle_stall/);
  });

  it('keeps persisted source-backed notices on the connector path even when userId=system', async () => {
    messageStore.append({
      userId: 'system',
      catId: null,
      content: '想交接给 @codex？把它单独放到新起一行开头，才能触发交接。',
      mentions: [],
      timestamp: 2500,
      threadId: 'thread-connector-notice',
      source: {
        connector: 'inline-mention-hint',
        label: '路由提示',
        icon: '💡',
        meta: { presentation: 'system_notice', noticeTone: 'info' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-connector-notice',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'connector');
    assert.equal(body.messages[0].catId, null);
    assert.equal(body.messages[0].source.connector, 'inline-mention-hint');
    assert.equal(body.messages[0].source.meta.presentation, 'system_notice');
  });

  it('maps a2a_routing system messages to type=system with extra.systemKind', async () => {
    messageStore.append({
      userId: 'system',
      catId: null,
      content: '布偶猫 → 缅因猫',
      mentions: [],
      timestamp: 3000,
      threadId: 'thread-routing',
      extra: {
        systemKind: 'a2a_routing',
        a2aRouting: { fromCatId: 'codex', targetCatId: 'opus-47', invocationId: 'inv-routing' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-routing',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'system');
    assert.equal(body.messages[0].catId, null);
    assert.equal(body.messages[0].content, '布偶猫 → 缅因猫');
    assert.equal(body.messages[0].extra.systemKind, 'a2a_routing');
    assert.deepEqual(body.messages[0].extra.a2aRouting, {
      fromCatId: 'codex',
      targetCatId: 'opus-47',
      invocationId: 'inv-routing',
    });
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=3',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.hasMore, true);
  });

  it('supports cursor pagination with before', async () => {
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }

    // Get messages before timestamp 1300 (should get msg 0, 1, 2)
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?before=1300&limit=10',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 'msg 0');
    assert.equal(body.messages[2].content, 'msg 2');
    assert.equal(body.hasMore, false);
  });

  it('pagination covers all messages without gaps (regression: slice direction)', async () => {
    // Insert 6 messages with distinct timestamps
    for (let i = 0; i < 6; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }

    // Page 1: most recent 2
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=2',
    });
    const body1 = JSON.parse(page1.body);
    assert.equal(body1.messages.length, 2);
    assert.equal(body1.hasMore, true);
    // Should be the 2 newest: msg 4 and msg 5
    assert.equal(body1.messages[0].content, 'msg 4');
    assert.equal(body1.messages[1].content, 'msg 5');

    // Page 2: before the oldest message of page 1
    const cursor = body1.messages[0].timestamp;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${cursor}`,
    });
    const body2 = JSON.parse(page2.body);
    assert.equal(body2.messages.length, 2);
    assert.equal(body2.hasMore, true);
    assert.equal(body2.messages[0].content, 'msg 2');
    assert.equal(body2.messages[1].content, 'msg 3');

    // Page 3: before page 2's oldest
    const cursor2 = body2.messages[0].timestamp;
    const page3 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${cursor2}`,
    });
    const body3 = JSON.parse(page3.body);
    assert.equal(body3.messages.length, 2);
    assert.equal(body3.hasMore, false);
    assert.equal(body3.messages[0].content, 'msg 0');
    assert.equal(body3.messages[1].content, 'msg 1');

    // Verify: union of all pages = all 6 messages, no gaps
    const allContents = [...body3.messages, ...body2.messages, ...body1.messages].map((m) => m.content);
    assert.deepEqual(allContents, ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5']);
  });

  it('composite cursor handles same-timestamp messages without gaps', async () => {
    // All messages at the same timestamp (simulates burst writes)
    for (let i = 0; i < 4; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `burst ${i}`,
        mentions: [],
        timestamp: 5000, // all same timestamp
      });
    }

    // First page: most recent 2
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=2',
    });
    const body1 = JSON.parse(page1.body);
    assert.equal(body1.messages.length, 2);
    assert.equal(body1.hasMore, true);

    // Composite cursor: "timestamp:id" of the oldest message on page 1
    const oldest = body1.messages[0];
    const cursor = `${oldest.timestamp}:${oldest.id}`;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${encodeURIComponent(cursor)}`,
    });
    const body2 = JSON.parse(page2.body);
    assert.equal(body2.messages.length, 2);
    assert.equal(body2.hasMore, false);

    // Union should have all 4, no duplicates
    const allIds = [...body2.messages, ...body1.messages].map((m) => m.id);
    assert.equal(new Set(allIds).size, 4, 'All 4 messages should be unique across pages');
  });

  it('returns toolEvents when message has them (缅因猫 R2 P1-2)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'I read the file',
      mentions: [],
      timestamp: 3000,
      toolEvents: [
        { id: 'tool-1', type: 'tool_use', label: 'opus → Read', detail: '{"path":"/a.ts"}', timestamp: 3000 },
        { id: 'toolr-1', type: 'tool_result', label: 'opus ← result', detail: 'file content...', timestamp: 3001 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);

    const msg = body.messages[0];
    assert.ok(msg.toolEvents, 'API response should include toolEvents');
    assert.equal(msg.toolEvents.length, 2);
    assert.equal(msg.toolEvents[0].type, 'tool_use');
    assert.equal(msg.toolEvents[0].label, 'opus → Read');
    assert.equal(msg.toolEvents[1].type, 'tool_result');
  });

  it('omits toolEvents when message has none', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'just text',
      mentions: [],
      timestamp: 4000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].toolEvents, undefined, 'should not include toolEvents when absent');
  });

  it('preserves stream invocation identity for persisted assistant messages', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'persisted stream bubble',
      mentions: [],
      timestamp: 4500,
      origin: 'stream',
      extra: {
        stream: {
          invocationId: 'inv-stream-1',
        },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.deepEqual(body.messages[0].extra?.stream, { invocationId: 'inv-stream-1' });
  });

  it('filters by userId', async () => {
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'alice msg',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'bob',
      catId: null,
      content: 'bob msg',
      mentions: [],
      timestamp: 2000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'alice msg');
  });

  // ── F97: Connector message type mapping ──────────────────────────

  it('maps message with source field to type=connector', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'GitHub Review 通知',
      mentions: ['opus'],
      timestamp: 9000,
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
        url: 'https://github.com/org/repo/pull/42',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);

    const msg = body.messages[0];
    assert.equal(msg.type, 'connector');
    assert.ok(msg.source, 'should include source in API response');
    assert.equal(msg.source.connector, 'github-review');
    assert.equal(msg.source.label, 'GitHub Review');
    assert.equal(msg.source.icon, '🔔');
    assert.equal(msg.source.url, 'https://github.com/org/repo/pull/42');
  });

  it('includes source.meta in API response (F098-C: needed for direction parsing)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'review notification',
      mentions: ['opus'],
      timestamp: 9002,
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
        url: 'https://github.com/org/repo/pull/42',
        meta: { targets: ['codex', 'gpt52'], initiator: 'opus' },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.type, 'connector');
    assert.equal(msg.source.connector, 'github-review');
    assert.equal(msg.source.url, 'https://github.com/org/repo/pull/42');
    assert.deepStrictEqual(
      msg.source.meta,
      { targets: ['codex', 'gpt52'], initiator: 'opus' },
      'source.meta must be included — frontend parseDirection reads meta.targets',
    );
  });

  it('serializes deliveredAt when present (F098-D P3 regression)', async () => {
    const stored = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'queued message',
      mentions: [],
      timestamp: 5000,
      deliveryStatus: 'queued',
    });
    messageStore.markDelivered(stored.id, 12000);

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.deliveredAt, 12000, 'deliveredAt must be serialized in API response');
  });

  it('omits deliveredAt when not set (F098-D P3 regression)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'immediate message',
      mentions: [],
      timestamp: 6000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.deliveredAt, undefined, 'deliveredAt must be absent when not set');
  });

  it('serializes extra.targetCats when present (F098-C1 regression)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'review done',
      mentions: ['codex'],
      origin: 'callback',
      timestamp: 7000,
      extra: { targetCats: ['codex', 'gpt52'] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.deepStrictEqual(
      msg.extra?.targetCats,
      ['codex', 'gpt52'],
      'extra.targetCats must be serialized for frontend direction rendering',
    );
  });

  it('message without source and without catId is type=user', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'normal user message',
      mentions: [],
      timestamp: 9001,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].source, undefined);
  });
});

// Auto-summary disabled (clowder-ai#343): summaries no longer merged into GET timeline.
// SummaryStore still persisted for memory infrastructure / future Thread Recap.
describe('GET /api/messages — summary NOT in timeline (clowder-ai#343)', () => {
  let app;
  let messageStore;
  let summaryStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    summaryStore = new SummaryStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      summaryStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('summaries exist in store but do NOT appear in timeline', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'hello',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'hi there',
      mentions: [],
      timestamp: 2000,
    });
    summaryStore.create({
      threadId: 'default',
      topic: '测试纪要',
      conclusions: ['结论一'],
      openQuestions: [],
      createdBy: 'system',
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2, 'only messages, no summary injection');
    assert.ok(
      body.messages.every((m) => m.type !== 'summary'),
      'no summary type in response',
    );
  });
});

describe('GET /api/messages summary + pagination contract', () => {
  let app;
  let messageStore;
  let summaryStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    summaryStore = new SummaryStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      summaryStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // Auto-summary disabled (clowder-ai#343): summaries no longer merged into timeline
  it('timeline does NOT inject summaries (clowder-ai#343)', async () => {
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }
    summaryStore.create({
      threadId: 'default',
      topic: '分页纪要',
      conclusions: [],
      openQuestions: [],
      createdBy: 'system',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=3',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.hasMore, true);
    const sumCount = body.messages.filter((m) => m.type === 'summary').length;
    assert.equal(sumCount, 0, 'summaries should not appear in timeline');
    assert.equal(body.messages.length, 3, 'only messages, no summary injection');
  });
});

describe('POST /api/messages orphan rejection (#21)', () => {
  it('returns 400 when threadId does not exist', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore: new ThreadStore(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'hello',
        userId: 'alice',
        threadId: 'nonexistent-thread',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_NOT_FOUND');

    await app.close();
  });
});

describe('POST /api/messages rejects soft-deleted thread (Phase D P1)', () => {
  it('returns 400 THREAD_NOT_FOUND when threadId is soft-deleted', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const threadStore = new ThreadStore();
    const thread = threadStore.create('alice', 'Will Be Deleted');
    threadStore.softDelete(thread.id);

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'should be rejected',
        userId: 'alice',
        threadId: thread.id,
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_NOT_FOUND');

    await app.close();
  });
});

describe('POST /api/messages delete-guard protection', () => {
  it('returns 409 and does not persist message when thread is being deleted', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const threadId = 'thread-delete-guard';
    const tracker = new InvocationTracker();
    const guard = tracker.guardDelete(threadId);
    assert.ok(guard.acquired, 'test setup: delete guard should be acquired');

    const messageStore = new MessageStore();
    const threadStore = {
      async get(id) {
        if (id !== threadId) return null;
        return {
          id: threadId,
          projectPath: 'default',
          title: 'Guarded Thread',
          createdBy: 'alice',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        };
      },
      async updateTitle() {},
      async updateLastActive() {},
      async getParticipants() {
        return [];
      },
      async addParticipants() {},
    };

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore,
      invocationTracker: tracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'should be blocked',
        userId: 'alice',
        threadId,
      },
    });

    // Wait briefly to ensure background path would have had time to append.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_DELETING');
    assert.equal(messageStore.getByThread(threadId).length, 0);

    guard.release();
    await app.close();
  });
});

// --- User timeline visibility policy ---

describe('GET /api/messages timeline visibility policy', () => {
  let app;
  let messageStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('preserves typed context_briefing messages in API response', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'user msg',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'system',
      catId: null,
      content: 'briefing nav',
      mentions: [],
      timestamp: 2000,
      origin: 'briefing',
      extra: { systemKind: 'context_briefing' },
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'cat reply',
      mentions: [],
      timestamp: 3000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 'user msg');
    assert.equal(body.messages[1].content, 'briefing nav');
    assert.equal(body.messages[1].extra.systemKind, 'context_briefing');
    assert.equal(body.messages[2].content, 'cat reply');
  });

  it('filters routing-guard-failure connector messages from API response', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'user msg',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'system',
      catId: null,
      content: 'route guard failed',
      mentions: [],
      timestamp: 2000,
      source: { connector: 'routing-guard-failure', detail: 'test' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'user msg');
  });

  it('preserves F233 duty briefing (origin=briefing without systemKind)', async () => {
    messageStore.append({
      userId: 'system',
      catId: null,
      content: 'duty briefing',
      mentions: [],
      timestamp: 1000,
      origin: 'briefing',
      extra: { rich: { v: 1, blocks: [{ id: 'duty-briefing', kind: 'card', v: 1, title: 'Duty' }] } },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'duty briefing');
  });

  it('loop-scans past large internal message clusters for pagination', async () => {
    // Regression: fixed overscan=20 would return {messages:[], hasMore:true}
    // when >20 consecutive internal messages exist between visible ones.
    const threadId = 'thread-internal-cluster';

    // Oldest visible message
    messageStore.append({
      threadId,
      userId: 'default-user',
      catId: null,
      content: 'oldest visible',
      mentions: [],
      timestamp: 100,
    });

    // 25 consecutive internal route-guard diagnostics
    for (let i = 0; i < 25; i++) {
      messageStore.append({
        threadId,
        userId: 'system',
        catId: null,
        content: `route-guard-${i}`,
        mentions: [],
        timestamp: 200 + i,
        source: { connector: 'routing-guard-failure', detail: 'test' },
      });
    }

    // Newest visible message
    messageStore.append({
      threadId,
      userId: 'default-user',
      catId: null,
      content: 'newest visible',
      mentions: [],
      timestamp: 300,
    });

    // Request with limit=1, cursor before newest visible
    // This forces pagination to walk through the 25 internal messages
    const cursor = `301:zzz`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=${threadId}&limit=1&before=${cursor}`,
    });
    const body = JSON.parse(res.body);

    // Must return the newest visible message, not an empty page
    assert.equal(body.messages.length, 1, 'should return 1 visible message, not empty page');
    assert.equal(body.messages[0].content, 'newest visible');
    assert.equal(body.hasMore, true, 'should indicate more messages exist');
  });

  it('scans past 300+ consecutive internal messages to reach buried visible (R4 regression)', async () => {
    // R3/R4 review (gpt52): the scan must reach visible messages regardless
    // of cluster size. This test places the ONLY visible message behind 300
    // internal messages — the loop must walk through all of them. A fixed
    // iteration cap (MAX_ITERATIONS=10) or scan limit (MAX_RAW_SCANNED=10000)
    // would fail this test if the cluster exceeded the cap.
    const threadId = 'thread-mega-cluster';
    const CLUSTER_SIZE = 300;

    // Only visible message — buried at the bottom behind the cluster
    messageStore.append({
      threadId,
      userId: 'default-user',
      catId: null,
      content: 'buried visible',
      mentions: [],
      timestamp: 100,
    });

    // 300 consecutive internal route-guard diagnostics on top
    for (let i = 0; i < CLUSTER_SIZE; i++) {
      messageStore.append({
        threadId,
        userId: 'system',
        catId: null,
        content: `route-guard-${i}`,
        mentions: [],
        timestamp: 200 + i,
        source: { connector: 'routing-guard-failure', detail: 'test' },
      });
    }

    // Cursor after all messages — forces scan through the entire cluster
    const cursor = `${200 + CLUSTER_SIZE + 1}:zzz`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=${threadId}&limit=1&before=${cursor}`,
    });
    const body = JSON.parse(res.body);

    // Must reach the buried visible message, not return empty page
    assert.equal(body.messages.length, 1, 'must reach buried visible past 300 internal');
    assert.equal(body.messages[0].content, 'buried visible');
    assert.equal(body.hasMore, false, 'no more messages after the only visible one');
  });

  it('returns hasMore=false when store is exhausted after filtering', async () => {
    const threadId = 'thread-exhausted';

    messageStore.append({
      threadId,
      userId: 'default-user',
      catId: null,
      content: 'only visible',
      mentions: [],
      timestamp: 100,
    });

    // A few internal route-guard diagnostics after
    for (let i = 0; i < 3; i++) {
      messageStore.append({
        threadId,
        userId: 'system',
        catId: null,
        content: `route-guard-${i}`,
        mentions: [],
        timestamp: 200 + i,
        source: { connector: 'routing-guard-failure', detail: 'test' },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=${threadId}&limit=50`,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'only visible');
    assert.equal(body.hasMore, false, 'store exhausted — no more messages');
  });
});
