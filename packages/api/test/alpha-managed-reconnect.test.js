import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { createAlphaManagedControl } from '../dist/infrastructure/scheduler/templates/alpha-managed-control.js';
import { alphaManagedFixture, until } from './helpers/alpha-managed-scheduler-fixture.js';

const owner = { userId: 'owner', threadId: 'alpha-thread', catId: 'codex-astra' };
const next = { ...owner, catId: 'codex61-sol' };
const consumer = {
  kind: 'alpha_revision_v1',
  subscriptionId: 'alpha-schedule',
  s3JobId: `alpha-browser-${'a'.repeat(64)}`,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-reconnect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ManagedJobService(root);
  const options = { repoRoot: root, dataRoot: root, subscriptionId: consumer.subscriptionId };
  const before = createAlphaManagedControl({ ...options, principal: owner });
  const original = await before({ action: 'prepare', consumer });
  const job = service.resolve(original.jobId);
  return { root, service, options, original, job, after: createAlphaManagedControl({ ...options, principal: next }) };
}

for (const state of ['queued', 'waiting', 'terminal']) {
  test(`guardian replacement reattaches the ${state} descriptor without minting or changing its owner`, async (t) => {
    const f = await fixture(t);
    if (state !== 'queued') {
      assert.equal(
        writeDurableGateRecord(f.job, {
          ...rawDurableGateRecord(f.job),
          state,
          ...(state === 'terminal'
            ? {
                terminalStatus: 'failed',
                cleanupProven: true,
                result: { exitCode: 70, timedOut: false, durationMs: 10 },
              }
            : {}),
        }),
        true,
      );
    }
    const rebound = await f.after({ action: 'prepare', consumer, jobId: f.job.jobId });
    assert.equal(rebound.jobId, f.job.jobId);
    assert.equal(rebound.inputPath, f.original.inputPath);
    assert.equal(rebound.gateReceiptPath, f.original.gateReceiptPath);
    assert.equal(f.service.list().length, 1);
    assert.deepEqual(f.service.resolve(f.job.jobId).definition.principal, owner);
    assert.throws(
      () => f.service.get(next, f.job.jobId),
      /managed_job_not_found/,
      'ordinary service access still requires the original cat',
    );
    if (state === 'terminal') {
      const observed = await f.after({ action: 'inspect', jobId: f.job.jobId });
      assert.equal(observed.state, 'failed');
      assert.equal(observed.result.exitCode, 70);
    }
  });
}

for (const mismatch of ['userId', 'threadId', 'subscriptionId', 's3JobId', 'headSha', 'baseSha']) {
  test(`a bound Alpha reconnect rejects a different ${mismatch}`, async (t) => {
    const f = await fixture(t);
    const principal = { ...next, ...(['userId', 'threadId'].includes(mismatch) ? { [mismatch]: 'another' } : {}) };
    const expected = {
      ...consumer,
      ...(!['userId', 'threadId'].includes(mismatch)
        ? {
            [mismatch]:
              mismatch === 's3JobId'
                ? `alpha-browser-${'d'.repeat(64)}`
                : ['headSha', 'baseSha'].includes(mismatch)
                  ? 'd'.repeat(40)
                  : 'another-subscription',
          }
        : {}),
    };
    const control = createAlphaManagedControl({ ...f.options, principal, subscriptionId: expected.subscriptionId });
    await assert.rejects(
      control({ action: 'prepare', consumer: expected, jobId: f.job.jobId }),
      /not_found|conflict|match/,
    );
    if (['userId', 'threadId', 'subscriptionId'].includes(mismatch)) {
      for (const action of ['inspect', 'start', 'cancel'])
        await assert.rejects(control({ action, jobId: f.job.jobId }), /not_found|conflict|unrelated/);
    }
    assert.equal(f.service.list().length, 1);
    assert.deepEqual(f.service.resolve(f.job.jobId).definition.principal, owner);
  });
}

test('an existing ordinary command cannot borrow the Alpha subscription authority', async (t) => {
  const f = await fixture(t);
  const ordinary = await f.service.submit(owner, {
    command: 'printf private',
    cwd: f.root,
    originTaskId: 'private-task',
    originInvocationId: randomUUID(),
    idempotencyKey: 'ordinary',
    executionSlaMs: 1000,
    wakeTarget: owner,
  });
  await assert.rejects(f.after({ action: 'prepare', consumer, jobId: ordinary.jobId }), /not_found|conflict|unrelated/);
  for (const action of ['inspect', 'start', 'cancel'])
    await assert.rejects(f.after({ action, jobId: ordinary.jobId }), /not_found|conflict|unrelated/);
  assert.equal(f.service.get(owner, ordinary.jobId).state, 'queued');
});

test(
  'a queued real Alpha starts once under its original owner after guardian handoff',
  { timeout: 30000 },
  async (t) => {
    const f = await alphaManagedFixture(t, { guardianCatId: next.catId });
    await f.run();
    assert.equal(f.service.list().length, 1);
    assert.equal(f.service.get(f.principal, f.managed.jobId).state, 'succeeded');
    assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
    assert.deepEqual(f.service.resolve(f.managed.jobId).definition.principal, f.principal);
  },
);

test('a new guardian reattaches the same live Alpha after its old transport exits', { timeout: 35000 }, async (t) => {
  const f = await alphaManagedFixture(t, {
    guardianCatId: next.catId,
    observeTransport: true,
    sources(root) {
      return {
        'waiting.test.mjs': `import test from 'node:test'; import {appendFileSync,existsSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises'; test('waiting', async()=>{appendFileSync(${JSON.stringify(join(root, 'executions.log'))},'once\\n'); while(!existsSync(${JSON.stringify(join(root, 'release'))})) await setTimeout(20);});`,
      };
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  t.after(() => clearTimeout(timer));
  const first = f.run(controller.signal, f.principal.catId).then(
    () => null,
    (e) => e,
  );
  await until(() => existsSync(f.marker), 'original command started');
  const before = f.service.get(f.principal, f.managed.jobId);
  process.kill(Number(readFileSync(f.transportPid, 'utf8')), 'SIGTERM');
  assert.match((await first)?.message ?? '', /without a clean result/);
  const resumed = f.run(controller.signal);
  writeFileSync(join(f.parent, 'release'), 'release');
  await resumed;
  const after = f.service.get(f.principal, f.managed.jobId);
  assert.equal(f.service.list().length, 1);
  assert.equal(after.attemptToken, before.attemptToken);
  assert.deepEqual(after.ownerIdentity, before.ownerIdentity);
  assert.equal(after.cleanupProven, true);
  assert.equal(readFileSync(f.marker, 'utf8'), 'once\n');
});
