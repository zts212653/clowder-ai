import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVELOPMENT_RETURN_TEMPLATE_ID, type DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { AutoDreamStore } from '../../src/domains/auto-dream/AutoDreamStore.js';
import { CatLifeSettingsService } from '../../src/domains/auto-dream/CatLifeSettingsService.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { type DynamicTaskDef, DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import {
  countHydratedRows,
  definition,
  history,
  registration,
  template,
} from '../helpers/dynamic-task-read-cost-fixture.js';

test('startup hydration excludes inactive payload history but retains private-return eligibility', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const store = new DynamicTaskStore(db);
  history(store);
  store.insert(definition('active', true));
  store.insert(
    definition('reviewed', true, DEVELOPMENT_RETURN_TEMPLATE_ID),
    undefined,
    registration('reviewed', 'waiting'),
    'reviewed',
  );
  store.insert(
    definition('retired', false, DEVELOPMENT_RETURN_TEMPLATE_ID),
    undefined,
    registration('retired', 'retired'),
    'successor',
  );
  assert.equal(db.prepare('SELECT enabled FROM dynamic_task_defs WHERE id=?').get('reviewed')?.enabled, 0);
  const visited: string[] = [];
  const runner = new TaskRunnerV2({ ledger: new RunLedger(db), logger: { info: () => {}, error: () => {} } });
  t.after(() => runner.stop());
  const reads = countHydratedRows(db);
  t.after(reads.stop);
  assert.equal(
    runner.hydrateDynamic(store, {
      get: (id) => {
        visited.push(id);
        return id === 'fixture' ? template : null;
      },
    }),
    1,
  );
  assert.deepEqual(runner.getRegisteredTasks(), ['active']);
  assert.equal(
    visited.filter((id) => id === DEVELOPMENT_RETURN_TEMPLATE_ID).length,
    1,
    'raw enabled=0 is not authoritative for private returns',
  );
  assert(reads.counts.length > 0);
  assert(
    Math.max(...reads.counts) <= 3,
    `startup hydrated ${Math.max(...reads.counts)} definitions instead of eligible candidates`,
  );
});

test('CatLife config and orphan reconciliation read only present-loop definitions without losing legacy identities', async (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const dynamic = new DynamicTaskStore(db);
  history(dynamic);
  for (const [id, owner, cat] of [
    ['duplicate', 'owner', 'codex61-sol'],
    ['orphan', 'owner', 'other-cat'],
    ['foreign', 'other-owner', 'codex61-sol'],
  ]) {
    dynamic.insert({
      ...definition(id, true, 'present-loop'),
      params: { triggerUserId: owner, targetCatId: cat },
      createdBy: 'legacy-creator',
    });
  }
  const store = new AutoDreamStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const registered = new Set<string>();
  const service = new CatLifeSettingsService({
    store,
    dynamicTaskStore: dynamic,
    taskRunner: {
      unregister: (id) => registered.delete(id),
      registerDynamic: (spec) => {
        registered.add(spec.id);
      },
    },
    templateRegistry: { get: () => template },
    threadStore: new ThreadStore(),
    privateOwnerUserId: 'owner',
    resolveCatTarget: () => ({ ok: 'codex61-sol' }),
  });
  const reads = countHydratedRows(db);
  t.after(reads.stop);
  const preview = await service.preview('owner', 'codex61-sol', {
    enabled: true,
    rhythm: { kind: 'gentle' },
    wakeTime: '22:30',
    timezone: 'America/Los_Angeles',
  });
  await service.decide('owner', preview.previewId, 'confirm');
  assert.equal(
    dynamic.getById('duplicate')?.enabled,
    false,
    'legacy creator must not bypass same-owner identity cleanup',
  );
  const outcome = await service.reconcileAll();
  assert.equal(outcome.reconciled, 1);
  assert.equal(outcome.disabledOrphans, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(dynamic.getById('orphan')?.enabled, false);
  assert.equal(dynamic.getById('foreign')?.enabled, true);
  assert.equal(registered.size, 1);
  assert(reads.counts.length > 0);
  assert(
    Math.max(...reads.counts) <= 4,
    `CatLife hydrated ${Math.max(...reads.counts)} definitions instead of present-loop candidates`,
  );
});

test('narrow readers preserve canonical projections, private-return precedence, ordering and native errors', (t) => {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const store = new DynamicTaskStore(db);
  store.insert(definition('active', true));
  store.insert(definition('inactive', false));
  store.insert(definition('loop-off', false, 'present-loop'));
  for (const storage of ['reviewed', 'successor'] as const) {
    for (const status of ['waiting', 'retired'] as const) {
      const id = `${storage}-${status}`;
      store.insert(definition(id, true, DEVELOPMENT_RETURN_TEMPLATE_ID), undefined, registration(id, status), storage);
    }
  }
  const before = store.getAll();
  assert.deepEqual(
    store.getEnabled(),
    before.filter((def) => def.enabled),
  );
  assert.deepEqual(
    store.getByTemplateId('present-loop'),
    before.filter((def) => def.templateId === 'present-loop'),
  );
  assert.deepEqual(
    store.getByTemplateId("present-loop' OR 1=1 --"),
    [],
    'template selection is bound, never SQL interpolation',
  );
  assert.deepEqual(store.getAll(), before, 'selectors do not mutate lifecycle state or provenance');
  db.prepare("UPDATE dynamic_task_defs SET params_json='broken-json' WHERE id='active'").run();
  assert.throws(
    () => store.getEnabled(),
    /JSON|Unexpected/,
    'a malformed eligible row cannot become an empty successful page',
  );
});
