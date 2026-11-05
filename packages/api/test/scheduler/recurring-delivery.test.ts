import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { createDeliverFn } from '../../dist/infrastructure/scheduler/delivery.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { createMainHealthTemplate } from '../../dist/infrastructure/scheduler/templates/main-health.js';
import { reminderTemplate } from '../../dist/infrastructure/scheduler/templates/reminder.js';
import type { TaskTemplate } from '../../dist/infrastructure/scheduler/templates/types.js';
import { webDigestTemplate } from '../../dist/infrastructure/scheduler/templates/web-digest.js';
import type { ScheduleRunTiming, TaskSpec_P1 } from '../../dist/infrastructure/scheduler/types.js';
import { createPersistedQueueFixture } from '../helpers/persisted-queue-fixture.js';

// Protect the actual producer → admission → Queue drain boundary. A deliver mock
// cannot detect a replay of an old message that the run ledger calls DELIVERED.
const owner = 'recurring-owner';
const threadId = 'recurring-thread';
const noop = () => {};

function task(template: TaskTemplate, id: string, extra: Record<string, unknown> = {}): TaskSpec_P1 {
  return template.createSpec(id, {
    trigger: { type: 'interval', ms: 7_200_000 },
    deliveryThreadId: threadId,
    params: {
      message: 'same reminder in a later occurrence',
      url: 'https://fixture.invalid/',
      targetCatId: 'opus',
      triggerUserId: owner,
      ...extra,
    },
  });
}

function harness() {
  const fixture = createPersistedQueueFixture();
  const db = new Database(':memory:');
  applyMigrations(db);
  const ledger = new RunLedger(db);
  const deliver = createDeliverFn({
    messageStore: fixture.messages,
    persistedQueueDelivery: fixture.delivery,
    socketManager: { emitToUser: noop, broadcastToRoom: noop },
  });
  const state = {
    running: new Map<string, boolean>(),
    tickCounts: new Map<string, number>(),
    lastRunAt: new Map<string, number | null>(),
  };
  return {
    ...fixture,
    deliver,
    ledger,
    async fire(spec: TaskSpec_P1, schedule?: ScheduleRunTiming) {
      await executeTaskPipeline({
        ...state,
        task: spec,
        ledger,
        logger: { info: noop, error: noop },
        deliver,
        schedule,
        fetchContent: async () => ({
          method: 'browser',
          text: '',
          title: '',
          url: 'https://fixture.invalid/',
          truncated: false,
        }),
      });
    },
    sources() {
      return fixture.messages.getByThread(threadId, 100, owner).filter((message) => message.from?.kind === 'system');
    },
    async finishNewest() {
      const source = this.sources().at(-1);
      assert.ok(source);
      await fixture.releaseProvider(await fixture.waitForAwakening(source.id));
    },
    async close() {
      await fixture.close();
      db.close();
    },
  };
}

function cronTiming(hour: string): ScheduleRunTiming {
  const scheduledAt = `2026-10-17T${hour}:00:00.000Z`;
  return {
    triggerKind: 'cron',
    scheduledAt,
    firedAt: scheduledAt,
    latenessMs: 0,
    missedSlots: 0,
    late: false,
    misfirePolicy: 'merge_late_one',
  };
}

for (const kind of ['interval', 'cron', 'browser-digest'] as const) {
  test(`${kind}: two occurrences with identical content start two real Queue children`, async () => {
    const f = harness();
    const spec = task(kind === 'browser-digest' ? webDigestTemplate : reminderTemplate, `periodic-${kind}`);
    if (kind === 'cron') spec.trigger = { type: 'cron', expression: '0 */2 * * *' };
    try {
      await f.fire(spec, kind === 'cron' ? cronTiming('10') : undefined);
      await f.finishNewest();
      await f.fire(spec, kind === 'cron' ? cronTiming('12') : undefined);
      assert.equal(f.sources().length, 2, 'a new occurrence must persist a new source, not return the old receipt');
      await f.finishNewest();
      assert.equal(f.starts.length, 2);
      assert.ok(f.ledger.query(spec.id, 10).every((row) => row.outcome === 'RUN_DELIVERED'));
      assert.equal(f.queue.list(threadId, owner).length, 0);
    } finally {
      await f.close();
    }
  });
}

test('different browser-digest plans for one URL do not suppress each other', async () => {
  const f = harness();
  try {
    await f.fire(task(webDigestTemplate, 'digest-one'));
    await f.finishNewest();
    await f.fire(task(webDigestTemplate, 'digest-two'));
    assert.equal(f.sources().length, 2);
    await f.finishNewest();
    assert.equal(f.starts.length, 2);
  } finally {
    await f.close();
  }
});

for (const changeReceipt of [false, true]) {
  test(`main-health red → green → red remains executable (receipt changes: ${changeReceipt})`, async () => {
    const f = harness();
    let tick = 0;
    const template = createMainHealthTemplate({
      inspectReceipt: async () => ({
        availability: 'available',
        headSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        receipt: { runId: changeReceipt ? `receipt-${tick}` : 'receipt', terminalAt: 1 },
        lastGreen: null,
        bisectCandidates: [],
      }),
      inspectLocalTree: async () => ({ headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), clean: true }),
      runHealthCheck: async () => ({ status: tick === 1 ? 'green' : 'red', outputTail: 'bounded fixture' }),
      readQuarantine: async () => null,
    });
    const spec = task(template, 'health-recurring', {
      repo: '/fixture',
      branch: 'main',
      healthCommand: 'pnpm check',
      guardianCatId: 'opus',
    });
    try {
      for (tick = 0; tick < 3; tick++) {
        await f.fire(spec);
        assert.equal(f.sources().length, tick + 1);
        await f.finishNewest();
      }
      assert.equal(f.starts.length, 3);
      assert.ok(f.ledger.query(spec.id, 10).every((row) => row.outcome === 'RUN_DELIVERED'));
    } finally {
      await f.close();
    }
  });
}

test('replaying the same cron slot still owns exactly one input', async () => {
  const f = harness();
  const spec = task(reminderTemplate, 'cron-retry');
  spec.trigger = { type: 'cron', expression: '0 */2 * * *' };
  try {
    await f.fire(spec, cronTiming('10'));
    await f.finishNewest();
    await f.fire(spec, cronTiming('10'));
    assert.equal(f.sources().length, 1);
    assert.equal(f.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('a later interval occurrence remains queued while the first child is processing', async () => {
  const f = harness();
  const spec = task(reminderTemplate, 'interval-busy');
  try {
    await f.fire(spec);
    const first = f.sources()[0];
    const child = await f.waitForAwakening(first.id);
    await f.fire(spec);
    const pending = f.queue.list(threadId, owner);
    assert.equal(pending.length, 1);
    const secondId = pending[0].payload.messageId;
    assert.ok(secondId && secondId !== first.id);
    await f.releaseProvider(child);
    await f.releaseProvider(await f.waitForAwakening(secondId));
    assert.equal(f.starts.length, 2);
  } finally {
    await f.close();
  }
});

test('two delivery attempts within one occurrence reuse its admission identity', async () => {
  const f = harness();
  const spec = task(reminderTemplate, 'interval-retry');
  const execute = spec.run.execute;
  spec.run.execute = async (signal, subject, ctx) => {
    await execute(signal, subject, ctx);
    await execute(signal, subject, ctx);
  };
  try {
    await f.fire(spec);
    assert.equal(f.sources().length, 1);
    await f.finishNewest();
    assert.equal(f.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('explicit manual runs get separate occurrences even for the same once task', async () => {
  const f = harness();
  const runner = new TaskRunnerV2({ logger: { info: noop, error: noop }, ledger: f.ledger, deliver: f.deliver });
  const spec = task(reminderTemplate, 'manual-repeat');
  spec.trigger = { type: 'once', fireAt: 1 };
  runner.register(spec);
  try {
    await runner.triggerNow(spec.id, { manual: true });
    await f.finishNewest();
    await runner.triggerNow(spec.id, { manual: true });
    assert.equal(f.sources().length, 2);
    await f.finishNewest();
    assert.equal(f.starts.length, 2);
  } finally {
    runner.stop();
    await f.close();
  }
});

test('managed hold identity stays single-use across runner occurrences', async () => {
  const f = harness();
  const spec = task(reminderTemplate, 'hold-ball-retry', { holdLifecycle: { mode: 'timer' } });
  spec.trigger = { type: 'once', fireAt: 1 };
  try {
    await f.fire(spec);
    await f.finishNewest();
    await f.fire(spec);
    assert.equal(f.sources().length, 1);
    assert.equal(f.starts.length, 1);
  } finally {
    await f.close();
  }
});
