import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';
import { SCHEMA_V8_DYNAMIC_TASKS } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { scheduleRoutes } from '../../dist/routes/schedule.js';

export function seedScheduleDefinitions(db, taskIds) {
  // Complete the V44 scheduler tables needed by the actual query/route path.
  for (const column of [
    'assigned_cat_id TEXT',
    'error_summary TEXT',
    'scheduled_at TEXT',
    'fired_at TEXT',
    'lateness_ms INTEGER',
    'missed_slots INTEGER',
    'trigger_kind TEXT',
    'misfire_policy TEXT',
  ])
    db.exec(`ALTER TABLE task_run_ledger ADD COLUMN ${column}`);
  db.exec(SCHEMA_V8_DYNAMIC_TASKS);
  db.exec(`ALTER TABLE dynamic_task_defs ADD COLUMN entrusted_work_reevaluation_json TEXT;
    ALTER TABLE dynamic_task_defs ADD COLUMN owner_auth_provenance TEXT;`);
  const store = new DynamicTaskStore(db);
  db.transaction(() => {
    for (const id of taskIds.slice(21)) {
      store.insert({
        id,
        templateId: 'synthetic-disabled',
        trigger: { type: 'interval', ms: 60000 },
        params: {},
        display: { label: id, category: 'system', description: 'Synthetic scale replay' },
        deliveryThreadId: null,
        enabled: false,
        createdBy: 'synthetic-owner',
        createdAt: '2026-09-08T00:00:00Z',
      });
    }
  })();
  return store;
}

export async function replayScheduleHttp(ledger, dynamicTaskStore, taskIds) {
  const runner = new TaskRunnerV2({ logger: { info() {}, error() {} }, ledger });
  for (const id of taskIds.slice(0, 21)) {
    runner.register({
      id,
      profile: 'poller',
      trigger: { type: 'interval', ms: 60000 },
      admission: { gate: async () => ({ run: false, reason: 'read-only scale fixture' }) },
      run: { overlap: 'skip', timeoutMs: 1000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'record' },
      enabled: () => false,
    });
  }
  // Do not start the runner: this process only serves the GET route on an ephemeral loopback port.
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true }));
  await app.register(scheduleRoutes, { taskRunner: runner, dynamicTaskStore });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const timings = [];
  const healthTimings = [];
  let body;
  try {
    for (let round = 0; round < 3; round += 1) {
      const start = performance.now();
      const [schedule, health] = await Promise.all([
        fetch(`${origin}/api/schedule/tasks`).then(async (response) => {
          assert.equal(response.status, 200);
          return { body: await response.text(), ms: performance.now() - start };
        }),
        fetch(`${origin}/health`).then(async (response) => {
          assert.equal(response.status, 200);
          await response.text();
          return performance.now() - start;
        }),
      ]);
      body = schedule.body;
      assert.equal(JSON.parse(body).tasks.length, taskIds.length);
      timings.push(Number(schedule.ms.toFixed(3)));
      healthTimings.push(Number(health.toFixed(3)));
    }
    return { timings, healthTimings, body, bytes: Buffer.byteLength(body) };
  } finally {
    runner.stop();
    await app.close();
  }
}
