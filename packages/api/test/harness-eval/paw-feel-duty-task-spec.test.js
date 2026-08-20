import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPawFeelDutyNotice,
  createPawFeelDutyTaskSpec,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-task-spec.js';

const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

function item(overrides = {}) {
  return {
    signalId: `message-1:${'a'.repeat(64)}:0`,
    bundleKey: 'message:message-1',
    sourceMessageId: 'message-1',
    state: 'new',
    sequence: 1,
    discoveredAt: new Date(NOW_MS - HOUR).toISOString(),
    lastTransitionAt: new Date(NOW_MS - HOUR).toISOString(),
    ...overrides,
  };
}

class MemoryWatermarkStore {
  current;

  async claim(watermark, claimedAt, snapshot) {
    if (!this.current || this.current.watermark !== watermark) {
      if (this.current && this.current.status !== 'complete') {
        if (this.current.status === 'delivered') {
          return {
            outcome: 'resume_invocation',
            watermark: this.current.watermark,
            messageId: this.current.messageId,
          };
        }
        if (this.current.status === 'awaiting_receipt') {
          return {
            outcome: 'resume_invocation',
            watermark: this.current.watermark,
            messageId: this.current.messageId,
          };
        }
        return { outcome: 'claimed_elsewhere' };
      }
      this.current = { watermark, status: 'claimed', updatedAt: claimedAt, snapshot };
      return { outcome: 'claimed' };
    }
    if (this.current.status === 'delivered') {
      return { outcome: 'resume_invocation', watermark: this.current.watermark, messageId: this.current.messageId };
    }
    if (this.current.status === 'awaiting_receipt') {
      return { outcome: 'resume_invocation', watermark: this.current.watermark, messageId: this.current.messageId };
    }
    return { outcome: this.current.status === 'complete' ? 'complete' : 'claimed_elsewhere' };
  }

  async readCurrent() {
    return this.current ? structuredClone(this.current) : null;
  }

  async markDelivered(watermark, messageId, updatedAt) {
    assert.equal(this.current.watermark, watermark);
    this.current = { ...this.current, status: 'delivered', messageId, updatedAt };
  }

  async markComplete(watermark, updatedAt) {
    assert.equal(this.current.watermark, watermark);
    this.current = { ...this.current, status: 'complete', updatedAt };
  }

  async markAwaitingReceipt(watermark, updatedAt) {
    assert.equal(this.current.watermark, watermark);
    this.current = { ...this.current, status: 'awaiting_receipt', updatedAt };
  }
}

function duty(primaryCatId = 'codex-sol', backupCatId = 'opus') {
  return {
    systemThreadId: 'thread_eval_friction',
    primaryCatId,
    backupCatId,
    version: 3,
    updatedAt: NOW,
    updatedBy: 'you',
  };
}

function makeTask(overrides = {}) {
  const watermarkStore = overrides.watermarkStore ?? new MemoryWatermarkStore();
  const receiptReconciler = overrides.receiptReconciler ?? {
    async reconcile() {
      return { outcome: 'incomplete' };
    },
  };
  return {
    watermarkStore,
    task: createPawFeelDutyTaskSpec({
      loadUndispositioned: overrides.loadUndispositioned ?? (async () => [item()]),
      loadDutyConfig: overrides.loadDutyConfig ?? (async () => duty()),
      watermarkStore,
      receiptReconciler,
      now: () => NOW,
      ownerUserId: 'user-1',
      inboxHref: '/workspace?tab=eval&section=paw-feel',
    }),
  };
}

describe('F278 paw-feel duty notice', () => {
  it('keeps the configured primary responsible at every SLA tier', () => {
    const normal = buildPawFeelDutyNotice([item()], duty(), NOW_MS, '/inbox');
    const overdue = buildPawFeelDutyNotice(
      [item({ discoveredAt: new Date(NOW_MS - 25 * HOUR).toISOString() })],
      duty(),
      NOW_MS,
      '/inbox',
    );
    const breach = buildPawFeelDutyNotice(
      [item({ discoveredAt: new Date(NOW_MS - 73 * HOUR).toISOString() })],
      duty(),
      NOW_MS,
      '/inbox',
    );

    assert.equal(normal.targetCatId, 'codex-sol');
    assert.equal(normal.slaTier, 'normal');
    assert.equal(overdue.targetCatId, 'codex-sol');
    assert.equal(overdue.slaTier, 'overdue');
    assert.match(overdue.content, /Primary 继续负责/);
    assert.doesNotMatch(overdue.content, /backup duty 接管/);
    assert.equal(breach.targetCatId, 'codex-sol');
    assert.equal(breach.slaTier, 'cvo_breach');
    assert.match(breach.content, /72h/);
    assert.match(breach.content, /Primary 继续负责/);
    assert.match(breach.content, /message-1/);
    assert.match(breach.content, /1 个 bundle \/ 1 条 raw signal/);
    assert.equal(breach.reviewBundleCount, 1);
    assert.equal(breach.rawSignalCount, 1);
    assert.doesNotMatch(breach.content, /爪感差:|marker body|phenomenon/i);
  });

  it('routes to the new primary after an explicit duty handoff', () => {
    const handedOff = buildPawFeelDutyNotice(
      [item({ discoveredAt: new Date(NOW_MS - 73 * HOUR).toISOString() })],
      duty('opus', 'codex-sol'),
      NOW_MS,
      '/inbox',
    );

    assert.equal(handedOff.targetCatId, 'opus');
    assert.equal(handedOff.slaTier, 'cvo_breach');
    assert.match(handedOff.content, /本批责任猫：@opus/);
  });

  it('keeps missing duty explicit instead of guessing an owner', () => {
    const notice = buildPawFeelDutyNotice([item()], null, NOW_MS, '/inbox');
    assert.equal(notice.targetCatId, undefined);
    assert.match(notice.content, /尚未配置值班猫/);
    assert.equal(notice.systemThreadId, 'thread_eval_friction');
  });

  it('treats a legacy primary-only config as incomplete instead of inventing backup takeover', () => {
    const partialDuty = duty();
    delete partialDuty.backupCatId;
    const notice = buildPawFeelDutyNotice(
      [item({ discoveredAt: new Date(NOW_MS - 25 * HOUR).toISOString() })],
      partialDuty,
      NOW_MS,
      '/inbox',
    );

    assert.equal(notice.slaTier, 'overdue');
    assert.equal(notice.targetCatId, undefined);
    assert.match(notice.content, /值班配置不完整/);
    assert.doesNotMatch(notice.content, /backup duty 接管|本批责任猫：@codex-sol/);
  });
});

describe('F278 paw-feel duty task', () => {
  it('delivers to the stable system thread, wakes the eligible cat, and dedupes the watermark', async () => {
    const fixture = makeTask({
      loadUndispositioned: async () => [
        item({ discoveredAt: new Date(NOW_MS - 25 * HOUR).toISOString() }),
        item({
          signalId: `message-1:${'b'.repeat(64)}:0`,
          sourceMessageId: 'message-1',
          discoveredAt: new Date(NOW_MS - 2 * HOUR).toISOString(),
        }),
      ],
    });
    assert.deepEqual(fixture.task.trigger, { type: 'cron', expression: '0 0,12 * * *', timezone: 'UTC' });

    const gate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    const delivered = [];
    const invoked = [];
    await fixture.task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver(input) {
        delivered.push(input);
        return 'notice-message-1';
      },
      invokeTrigger: {
        async trigger(...args) {
          invoked.push(args);
        },
      },
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].threadId, 'thread_eval_friction');
    assert.equal(delivered[0].userId, 'user-1');
    assert.match(delivered[0].content, /1 个 bundle \/ 2 条 raw signal/);
    assert.match(delivered[0].content, /10\/20\/50 条上限只限制.*切片，不是任务终点/);
    assert.match(delivered[0].content, /真实 task.*named owner.*active F167 lease.*durable proposal/);
    assert.match(delivered[0].content, /预算将尽.*结构化续跑.*下一轮 cron/);
    assert.doesNotMatch(delivered[0].content, /owner\/task\/lease\/proposal blocker/);
    assert.equal((delivered[0].content.match(/- message-1/g) ?? []).length, 1);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0][0], 'thread_eval_friction');
    assert.equal(invoked[0][1], 'codex-sol');
    assert.match(invoked[0][3], /1 review bundle\(s\) \/ 2 raw signal\(s\)/i);
    assert.match(invoked[0][3], /10\/20\/50-item slices are execution limits, not a terminal condition/i);
    assert.match(invoked[0][3], /real task \+ named owner \+ active F167 lease/i);
    assert.match(invoked[0][3], /durable proposal awaiting operator approval/i);
    assert.match(invoked[0][3], /signature-waiting must continue.*independent signature or blocker/i);
    assert.match(invoked[0][3], /structured continuation instead of waiting for the next duty cron/i);
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');

    const retryGate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: 1, tickCount: 2 });
    assert.equal(retryGate.run, true);
    assert.equal(retryGate.workItems[0].signal.deliveryRequired, false);
    assert.equal(retryGate.workItems[0].signal.messageId, 'notice-message-1');
    await fixture.task.run.execute(retryGate.workItems[0].signal, retryGate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver() {
        assert.fail('awaiting receipt recovery must reuse the durable notice');
      },
      invokeTrigger: {
        async trigger(...args) {
          invoked.push(args);
        },
      },
    });
    assert.equal(invoked.length, 2);
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');
  });

  it('delivers a red no-owner notice without invoking or inventing a cat', async () => {
    let currentDuty = null;
    let currentItems = [item()];
    const fixture = makeTask({
      loadDutyConfig: async () => currentDuty,
      loadUndispositioned: async () => currentItems,
    });
    const gate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: null, tickCount: 1 });
    const originalWatermark = gate.workItems[0].signal.watermark;
    const delivered = [];
    await fixture.task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver(input) {
        delivered.push(input);
        return 'notice-message-1';
      },
      invokeTrigger: {
        async trigger() {
          assert.fail('missing duty must not guess an invocation target');
        },
      },
    });

    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content, /尚未配置值班猫/);
    assert.equal(fixture.watermarkStore.current.status, 'delivered');

    currentDuty = duty();
    currentItems = [
      ...currentItems,
      item({
        signalId: `message-2:${'b'.repeat(64)}:0`,
        bundleKey: 'message:message-2',
        sourceMessageId: 'message-2',
      }),
    ];
    const resumedGate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: 1, tickCount: 2 });
    assert.equal(resumedGate.run, true);
    assert.equal(resumedGate.workItems[0].signal.deliveryRequired, false);
    assert.equal(resumedGate.workItems[0].signal.watermark, originalWatermark);
    assert.equal(resumedGate.workItems[0].dedupeKey, originalWatermark);
    assert.equal(resumedGate.workItems[0].signal.rawSignalCount, 1);
    assert.equal(resumedGate.workItems[0].signal.reviewBundleCount, 1);
    const invoked = [];
    await fixture.task.run.execute(resumedGate.workItems[0].signal, resumedGate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver() {
        assert.fail('duty configuration must reuse the durable red notice');
      },
      invokeTrigger: {
        async trigger(...args) {
          invoked.push(args);
        },
      },
    });
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0][1], 'codex-sol');
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');
  });

  it('retries a failed invocation from the delivered message without sending a second notice', async () => {
    const fixture = makeTask();
    const firstGate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: null, tickCount: 1 });
    let deliveries = 0;
    await assert.rejects(
      fixture.task.run.execute(firstGate.workItems[0].signal, firstGate.workItems[0].subjectKey, {
        assignedCatId: null,
        async deliver() {
          deliveries += 1;
          return 'notice-message-1';
        },
        invokeTrigger: {
          async trigger() {
            throw new Error('wake unavailable');
          },
        },
      }),
      /wake unavailable/,
    );
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');

    const retryGate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: 1, tickCount: 2 });
    assert.equal(retryGate.run, true);
    assert.equal(retryGate.workItems[0].signal.deliveryRequired, false);
    await fixture.task.run.execute(retryGate.workItems[0].signal, retryGate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver() {
        deliveries += 1;
        return 'duplicate';
      },
      invokeTrigger: { async trigger() {} },
    });

    assert.equal(deliveries, 1);
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');
  });

  it('writes an incomplete receipt from the scheduler before a duty invocation can fail', async () => {
    const reconciliations = [];
    const fixture = makeTask({
      receiptReconciler: {
        async reconcile(actorCatId) {
          reconciliations.push({ actorCatId, status: fixture.watermarkStore.current.status });
          return { outcome: 'incomplete' };
        },
      },
    });
    const gate = await fixture.task.admission.gate({ taskId: fixture.task.id, lastRunAt: null, tickCount: 1 });

    await assert.rejects(
      fixture.task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
        assignedCatId: null,
        async deliver() {
          return 'notice-message-1';
        },
        invokeTrigger: {
          async trigger() {
            throw new Error('usage limit');
          },
        },
      }),
      /usage limit/,
    );

    assert.deepEqual(reconciliations, [
      { actorCatId: 'scheduler:paw-feel-disposition-duty', status: 'awaiting_receipt' },
    ]);
    assert.equal(fixture.watermarkStore.current.status, 'awaiting_receipt');
  });
});
