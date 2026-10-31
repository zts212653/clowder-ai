import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import '../helpers/setup-cat-registry.js';

const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { CustodyOpportunityCohortStore } = await import('../../dist/domains/growing/CustodyOpportunityCohortStore.js');
const { CustodyOpportunityRuntime } = await import('../../dist/domains/growing/CustodyOpportunityRuntime.js');

test('cohort registration and the immutable review receipt survive closing and reopening the SQLite database', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f310-custody-evidence-'));
  let db = new Database(join(dir, 'evidence.sqlite'));
  t.after(async () => {
    if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });
  let now = 1_789_000_000_000;
  const deps = { messages: new MessageStore(), tasks: new TaskStore(), policyVersion: 'policy-v1', now: () => now };
  const runtime = new CustodyOpportunityRuntime({ ...deps, cohorts: new CustodyOpportunityCohortStore(db) });
  const registration = runtime.register('owner');
  now += 30 * 86_400_000;
  const ref = await runtime.reconcile('owner');
  const frozen = runtime.readFrozen('owner', ref);
  db.close();
  db = new Database(join(dir, 'evidence.sqlite'));
  now += 86_400_000;
  const restarted = new CustodyOpportunityRuntime({ ...deps, cohorts: new CustodyOpportunityCohortStore(db) });
  assert.deepEqual(restarted.register('owner'), registration);
  assert.deepEqual(restarted.readFrozen('owner', ref), frozen);
  assert.equal(restarted.readFrozen('other-owner', ref), null);
  assert.equal(await restarted.reconcile('owner'), ref);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM f310_custody_cohort_snapshots').get().count, 1);
  assert.equal(deps.tasks.listByKind('work').length, 0);
});
