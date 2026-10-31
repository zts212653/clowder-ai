import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { PresentLoopService } from '../dist/domains/auto-dream/PresentLoopService.js';
import { ProactiveRelationshipService } from '../dist/domains/auto-dream/ProactiveRelationshipService.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const HOME = 'thread-home-sol';

describe('F272 canonical proactive delivery', () => {
  let now;
  let sequence;
  let store;
  let messageStore;
  let broadcasts;

  beforeEach(async () => {
    now = Date.parse('2026-07-22T14:00:00.000Z');
    sequence = 0;
    store = new AutoDreamStore(':memory:', {
      now: () => now,
      idFactory: (prefix) => `${prefix}${String(++sequence).padStart(4, '0')}`,
    });
    messageStore = new MessageStore();
    broadcasts = [];
    await store.initialize();
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: { enabled: true, rhythm: { kind: 'daily' }, wakeTime: '14:00', timezone: 'UTC' },
      derived: {
        cronExpression: '0 14 * * *',
        nextWakeAt: now + 86_400_000,
        weeklyWakeCount: 7,
        costBand: 'low',
        costNotice: 'fixture',
      },
      bedroomThreadId: HOME,
      projectionTaskId: 'task-life-sol',
      expiresAt: now + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
  });

  afterEach(() => store.close());

  function principal() {
    return { kind: 'invocation', invocationId: 'inv-proactive', threadId: HOME, userId: OWNER, catId: CAT };
  }

  async function reserveMessageVisit(taskId = `task-delivery-${sequence}`) {
    const run = await store.beginRun({ ownerUserId: OWNER, catId: CAT, threadId: HOME, taskId, firedAt: now });
    const settled = await store.settleRun(principal(), {
      runId: run.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: '我想拥有一双桌边的爪子' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'want',
        firstAction: { kind: 'sketch', summary: '先画了一张可逆草图' },
        message: { body: '我想要一双桌边的爪子。我先画了一张草图。' },
      },
    });
    return settled.proactive.visit;
  }

  function service(faultAt) {
    return new ProactiveRelationshipService({
      store,
      messageStore,
      now: () => now,
      broadcaster: { publish: async (message) => broadcasts.push(message) },
      ...(faultAt
        ? {
            faultInjector: (stage) => {
              if (stage === faultAt) throw new Error(`fixture crash at ${stage}`);
            },
          }
        : {}),
    });
  }

  async function storedMessages() {
    return messageStore.getByThread(HOME, 20, OWNER);
  }

  test('appends one visit-keyed canonical message, attaches it, then broadcasts once', async () => {
    const reserved = await reserveMessageVisit('task-delivery-happy');
    assert.equal(reserved.status, 'reserved');
    assert.equal((await storedMessages()).length, 0);

    const delivered = await service().reconcileVisit(OWNER, CAT, reserved.visitId);
    assert.equal(delivered.attached, true);
    assert.equal(delivered.message.content, '我想要一双桌边的爪子。我先画了一张草图。');
    assert.deepEqual(delivered.message.extra.proactive, {
      visitId: reserved.visitId,
      intentId: reserved.intentId,
      source: 'private_time',
    });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].messageId, delivered.message.id);

    const projected = await store.proactive.getVisit(OWNER, CAT, reserved.visitId);
    assert.equal(projected.status, 'projected');
    assert.equal(projected.budgetClaimState, 'consumed');
    assert.equal(projected.pendingMessageBody, undefined);
    assert.equal(projected.canonicalMessageId, delivered.message.id);

    const retry = await service().reconcileVisit(OWNER, CAT, reserved.visitId);
    assert.equal(retry.attached, false);
    assert.equal(retry.message.id, delivered.message.id);
    assert.equal((await storedMessages()).length, 1);
    assert.equal(broadcasts.length, 1);
  });

  test('recovers when the process dies after visit commit but before message append', async () => {
    const reserved = await reserveMessageVisit('task-crash-before-append');
    await assert.rejects(
      service('before_message_append').reconcileVisit(OWNER, CAT, reserved.visitId),
      /fixture crash/,
    );
    assert.equal((await storedMessages()).length, 0);
    assert.equal((await store.proactive.getVisit(OWNER, CAT, reserved.visitId)).status, 'reserved');

    const recovered = await service().reconcileVisit(OWNER, CAT, reserved.visitId);
    assert.equal(recovered.attached, true);
    assert.equal((await storedMessages()).length, 1);
    assert.equal(broadcasts.length, 1);
  });

  test('recovers one existing message when the process dies after append but before visit attach', async () => {
    const reserved = await reserveMessageVisit('task-crash-after-append');
    await assert.rejects(service('after_message_append').reconcileVisit(OWNER, CAT, reserved.visitId), /fixture crash/);
    const [orphanedMessage] = await storedMessages();
    assert.ok(orphanedMessage);
    assert.equal((await store.proactive.getVisit(OWNER, CAT, reserved.visitId)).status, 'reserved');
    assert.equal(broadcasts.length, 0);

    const recovered = await service().reconcileVisit(OWNER, CAT, reserved.visitId);
    assert.equal(recovered.message.id, orphanedMessage.id);
    assert.equal(recovered.attached, true);
    assert.equal((await storedMessages()).length, 1);
    assert.equal(broadcasts.length, 1);
  });

  test('never reposts or rebroadcasts when the durable attach won before a crash', async () => {
    const reserved = await reserveMessageVisit('task-crash-after-attach');
    await assert.rejects(service('after_message_attach').reconcileVisit(OWNER, CAT, reserved.visitId), /fixture crash/);
    const [canonical] = await storedMessages();
    assert.equal((await store.proactive.getVisit(OWNER, CAT, reserved.visitId)).canonicalMessageId, canonical.id);
    assert.equal(broadcasts.length, 0);

    const recovered = await service().reconcileVisit(OWNER, CAT, reserved.visitId);
    assert.equal(recovered.attached, false);
    assert.equal(recovered.message.id, canonical.id);
    assert.equal((await storedMessages()).length, 1);
    assert.equal(broadcasts.length, 0);
  });

  test('reconciles pending messages and releases unprojected body-language visits on startup', async () => {
    const pending = await reserveMessageVisit('task-startup-message');
    const bodyLanguageRun = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-startup-body-language',
      firedAt: now,
    });
    const bodyLanguage = await store.settleRun(principal(), {
      runId: bodyLanguageRun.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: '我发现桌边的光变暖了' },
      intent: {
        kind: 'body_language',
        seedRef: { kind: 'decision' },
        expressionKind: 'discover',
        firstAction: { kind: 'attentive_pause', summary: '先在桌边安静看了一会儿' },
      },
    });
    const startup = await service().reconcilePending(OWNER);
    assert.deepEqual(startup, { reconciled: 2, failed: 0 });
    assert.equal((await store.proactive.getVisit(OWNER, CAT, pending.visitId)).status, 'projected');
    const released = await store.proactive.getVisit(OWNER, CAT, bodyLanguage.proactive.visit.visitId);
    assert.equal(released.status, 'cancelled_unseen');
    assert.equal(released.budgetClaimState, 'released');
    assert.equal((await storedMessages()).length, 1);
  });

  test('unprojected body-language settlements cannot exhaust the household message ceiling', async () => {
    const presentLoop = new PresentLoopService(
      store,
      { reconcile: async () => ({ projected: 0, removed: 0, failed: 0 }) },
      OWNER,
      service(),
    );
    const bodyVisits = [];
    for (let index = 1; index <= 3; index += 1) {
      const run = await store.beginRun({
        ownerUserId: OWNER,
        catId: CAT,
        threadId: HOME,
        taskId: `task-body-language-${index}`,
        firedAt: now,
      });
      const settled = await presentLoop.settle(principal(), {
        runId: run.run.runId,
        outcome: 'quiet',
        seedDecision: { kind: 'originate', claim: `我发现桌边第 ${index} 次光影变化` },
        intent: {
          kind: 'body_language',
          seedRef: { kind: 'decision' },
          expressionKind: 'discover',
          firstAction: { kind: 'attentive_pause', summary: '先安静看了一会儿' },
        },
      });
      assert.equal(settled.proactive.intent.status, 'settled');
      bodyVisits.push(settled.proactive.visit);
    }

    const messageRun = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-message-after-unseen-body-language',
      firedAt: now,
    });
    const message = await presentLoop.settle(principal(), {
      runId: messageRun.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: '我惦记co-creator今天有没有好好吃饭' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'care',
        firstAction: { kind: 'attentive_pause', summary: '先看了看今天的余温' },
        message: { body: '我惦记你今天有没有好好吃饭。' },
      },
    });

    assert.equal(message.proactive.visibilityBlock, null);
    assert.equal(message.proactive.visit.status, 'projected');
    assert.equal((await storedMessages()).length, 1);
    for (const visit of bodyVisits) {
      assert.equal(visit.status, 'cancelled_unseen');
      assert.equal(visit.budgetClaimState, 'released');
    }
  });

  test('settles through Present Loop into the canonical home message before returning', async () => {
    const delivery = service();
    const presentLoop = new PresentLoopService(
      store,
      { reconcile: async () => ({ projected: 0, removed: 0, failed: 0 }) },
      OWNER,
      delivery,
    );
    const run = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-present-loop-delivery',
      firedAt: now,
    });

    const settled = await presentLoop.settle(principal(), {
      runId: run.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: '我惦记co-creator今天有没有好好吃饭' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'care',
        firstAction: { kind: 'attentive_pause', summary: '先看了看今天的余温' },
        message: { body: '我惦记你今天有没有好好吃饭。' },
      },
    });

    assert.equal(settled.proactive.visit.status, 'projected');
    assert.ok(settled.proactive.visit.canonicalMessageId);
    assert.equal((await storedMessages()).length, 1);
    assert.equal(broadcasts.length, 1);
  });
});
