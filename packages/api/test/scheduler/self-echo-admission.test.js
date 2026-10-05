import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { EmissionStore } from '../../dist/infrastructure/scheduler/EmissionStore.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { createMainHealthTemplate } from '../../dist/infrastructure/scheduler/templates/main-health.js';
import { createPresentLoopTemplate } from '../../dist/infrastructure/scheduler/templates/present-loop.js';
import { reminderTemplate } from '../../dist/infrastructure/scheduler/templates/reminder.js';
import { createRepoActivityTemplate } from '../../dist/infrastructure/scheduler/templates/repo-activity.js';
import { webDigestTemplate } from '../../dist/infrastructure/scheduler/templates/web-digest.js';

const INTERVAL_MS = 50 * 60_000;
const THREAD = 'thread-reminder';
const START = Date.parse('2026-10-02T18:28:34.397Z');
const params = {
  message: '自由时间',
  targetCatId: 'codex61-sol',
  triggerUserId: 'owner',
  url: 'https://example.com',
  repo: '/projects/example',
  branch: 'main',
  healthCommand: 'pnpm check',
  guardianCatId: 'codex61-sol',
};

describe('scheduler self-echo admission boundary', () => {
  let db, ledger, emissionStore, context, delivered;

  beforeEach((t) => {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    emissionStore = new EmissionStore(db);
    delivered = [];
    context = {
      ledger,
      emissionStore,
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
      logger: { info() {}, error() {} },
      deliver: async (opts) => {
        delivered.push(opts);
        t.mock.timers.tick(200); // emission is written after delivery settles
        return `message-${delivered.length}`;
      },
      invokeTrigger: { trigger: async () => 'dispatched' },
      fetchContent: async (url) => ({ url, title: 'Example', text: 'digest', method: 'server-fetch' }),
    };
  });

  afterEach(() => db.close());

  function spec(template, trigger = { type: 'interval', ms: INTERVAL_MS }) {
    return template.createSpec(`test-${template.templateId}`, { trigger, params, deliveryThreadId: THREAD });
  }

  function seedEmission(task) {
    emissionStore.record({
      originTaskId: task.id,
      threadId: THREAD,
      messageId: 'legacy-message',
      suppressionMs: INTERVAL_MS * 2,
    });
  }

  const factories = [
    ['reminder', () => reminderTemplate],
    ['web-digest', () => webDigestTemplate],
    [
      'repo-activity',
      () =>
        createRepoActivityTemplate({
          getGitHubToken: () => 'self-echo-fixture-token',
          execFileAsync: async (file, args) => {
            assert.equal(file, 'gh');
            assert.equal(args[0], 'api');
            return { stdout: '[]' };
          },
        }),
    ],
    [
      'main-health',
      () =>
        createMainHealthTemplate({
          inspectReceipt: async () => ({
            availability: 'unavailable',
            headSha: null,
            treeSha: null,
            receipt: null,
            lastGreen: null,
            bisectCandidates: [],
          }),
          inspectLocalTree: async () => ({ headSha: 'head', treeSha: 'tree', clean: true }),
          runHealthCheck: async () => ({ status: 'red', outputTail: 'failed check' }),
        }),
    ],
    [
      'present-loop',
      () =>
        createPresentLoopTemplate({
          service: {
            acceptsOwner: () => true,
            beginScheduledRun: async () => ({
              created: true,
              run: { runId: 'run' },
              proactiveContext: { ownedSeeds: [] },
            }),
            renderPersistedWakeTrigger: () => 'private time',
            renderWakePrompt: () => 'private time',
            failWake: async () => {},
          },
        }),
    ],
  ];

  for (const [name, factory] of factories) {
    it(`${name}: thread delivery does not suppress the next 50-minute tick`, async (t) => {
      const task = spec(factory());
      await executeTaskPipeline({ ...context, task });
      assert.equal(delivered.length, 1);
      t.mock.timers.setTime(START + INTERVAL_MS);
      await executeTaskPipeline({ ...context, task });
      assert.equal(delivered.length, 2, 'the next scheduled tick must deliver');
      assert.deepEqual(
        ledger.query(task.id, 10).map((r) => r.outcome),
        ['RUN_DELIVERED', 'RUN_DELIVERED'],
      );
      assert.equal(emissionStore.listActive().length, 0, 'independent gates do not create echo windows');
    });

    it(`${name}: an existing emission from the old pipeline does not suppress execution`, async () => {
      const task = spec(factory());
      seedEmission(task);
      await executeTaskPipeline({ ...context, task });
      assert.equal(delivered.length, 1);
      assert.equal(ledger.query(task.id, 1)[0].outcome, 'RUN_DELIVERED');
      assert.equal(emissionStore.listActive().length, 1, 'legacy records need no migration');
    });
  }

  it('cron reminders deliver again inside the old five-minute echo window', async (t) => {
    const task = spec(reminderTemplate, { type: 'cron', expression: '* * * * *' });
    await executeTaskPipeline({ ...context, task });
    t.mock.timers.setTime(START + 60_000);
    await executeTaskPipeline({ ...context, task });
    assert.equal(delivered.length, 2);
  });

  it('once reminders ignore a pre-existing echo window', async () => {
    const task = spec(reminderTemplate, { type: 'once', fireAt: START });
    seedEmission(task);
    await executeTaskPipeline({ ...context, task });
    assert.equal(delivered.length, 1);
  });

  for (const dependsOnThreadActivity of [true, undefined]) {
    it(`thread-driven gates retain self-echo suppression (${dependsOnThreadActivity ?? 'legacy default'})`, async (t) => {
      const task = spec(reminderTemplate);
      task.admission = {
        ...(dependsOnThreadActivity === undefined ? {} : { dependsOnThreadActivity }),
        gate: async () => ({ run: true, workItems: [{ signal: 'thread changed', subjectKey: `thread-${THREAD}` }] }),
      };
      await executeTaskPipeline({ ...context, task });
      const emission = emissionStore.listActive()[0];
      assert.equal(Date.parse(emission.suppressionUntil), START + 200 + INTERVAL_MS * 2);
      t.mock.timers.setTime(START + INTERVAL_MS);
      await executeTaskPipeline({ ...context, task });
      assert.equal(delivered.length, 1);
      assert.equal(ledger.query(task.id, 1)[0].outcome, 'SKIP_SELF_ECHO');
      t.mock.timers.setTime(START + 200 + INTERVAL_MS * 2);
      await executeTaskPipeline({ ...context, task });
      assert.equal(delivered.length, 2, 'the dependent gate runs when the echo window expires');
    });
  }
});
