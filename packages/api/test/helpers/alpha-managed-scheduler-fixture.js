import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alphaBrowserFailureTasks } from '../../../../scripts/lib/alpha-browser-failures.mjs';
import { alphaBrowserMaterializationContract } from '../../../../scripts/lib/alpha-browser-materialization-contract.mjs';
import { runAlphaBrowserProcess } from '../../../../scripts/lib/alpha-browser-process.mjs';
import { discoverAlphaBrowserRevisionSnapshot } from '../../../../scripts/lib/alpha-browser-revisions.mjs';
import { openAlphaBrowserSubscription } from '../../../../scripts/lib/alpha-browser-subscription.mjs';
import * as executionApi from '../../../../scripts/lib/gate-execution-api.mjs';
import { git, initializeExecutionTree } from '../../../../scripts/lib/gate-execution-runner-fixture.mjs';
import { verificationFingerprint } from '../../../../scripts/lib/verification-fingerprint.mjs';
import {
  rawDurableGateRecord,
  writeDurableGateRecord,
} from '../../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../../dist/domains/managed-job/ManagedJobService.js';
import { createAlphaBrowserTemplate } from '../../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { createAlphaManagedControl } from '../../dist/infrastructure/scheduler/templates/alpha-managed-control.js';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const principal = { userId: 'owner', threadId: 'alpha-thread', catId: 'codex-astra' };

export async function alphaManagedFixture(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'alpha-managed-scheduler-'));
  const repoRoot = join(parent, 'repo'),
    dataRoot = join(parent, 'data');
  mkdirSync(repoRoot);
  const before = {
    CAT_CAFE_DATA_DIR: process.env.CAT_CAFE_DATA_DIR,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE: process.env.CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE,
    PATH: process.env.PATH,
  };
  process.env.CAT_CAFE_DATA_DIR = dataRoot;
  delete process.env.NODE_TEST_CONTEXT;
  const pressure = join(parent, 'pressure.json');
  writeFileSync(pressure, JSON.stringify({ pressure: 'normal' }));
  process.env.CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE = pressure;
  const service = new ManagedJobService(dataRoot);
  t.after(async () => {
    for (const job of service.list()) service.cancel(principal, job.jobId);
    for (let n = 0; n < 100; n++) {
      await service.reconcile();
      if (
        service
          .list()
          .every((job) =>
            ['succeeded', 'failed', 'lost', 'cancelled', 'timed_out'].includes(service.get(principal, job.jobId).state),
          )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(parent, { recursive: true, force: true });
  });
  const baselineSha = initializeExecutionTree(repoRoot);
  const marker = join(parent, 'executions.log');
  const sources = options.sources?.(parent) ?? {
    'sample.mjs': `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'once\\n');\n`,
  };
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(repoRoot, name), content);
  const installLog = join(parent, 'installs.log');
  if (options.materializationExitCode !== undefined) {
    mkdirSync(join(repoRoot, 'packages/web'), { recursive: true });
    writeFileSync(join(repoRoot, 'packages/web/.fixture'), 'private materialization input');
    const bin = join(parent, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      `#!${process.execPath}
      if (process.argv[2] === '--version') { console.log('private-pnpm'); process.exit(0); }
      require('node:fs').appendFileSync(${JSON.stringify(installLog)}, 'once\\n');
      process.exit(${options.materializationExitCode});`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  }
  git(repoRoot, [
    'add',
    ...Object.keys(sources),
    ...(options.materializationExitCode === undefined ? [] : ['packages/web/.fixture']),
  ]);
  git(repoRoot, ['commit', '-qm', 'one small verification unit']);
  const targetSha = git(repoRoot, ['rev-parse', 'HEAD']);
  mkdirSync(join(repoRoot, 'scripts'));
  symlinkSync(join(sourceRoot, 'scripts/lib'), join(repoRoot, 'scripts/lib'), 'dir');
  writeFileSync(join(repoRoot, '.git/info/exclude'), 'scripts/\n');
  const input = {
    repoRoot,
    baselineSha,
    targetSha,
    subscriptionId: 'alpha-schedule',
    ownerPrincipal: 'schedule:owner:alpha-schedule',
    originTaskId: 'alpha-schedule',
    databasePath: join(parent, 'gate.sqlite'),
    legacyLockPath: join(parent, 'gate.lock'),
  };
  const store = openAlphaBrowserSubscription(input);
  store.enroll(discoverAlphaBrowserRevisionSnapshot({ repoRoot, subscribedAfterSha: baselineSha, targetSha }));
  const revision = store.pending();
  store.claimExecutionCarrier(targetSha, 'managed');
  const control = createAlphaManagedControl({ repoRoot, principal, subscriptionId: input.subscriptionId, dataRoot });
  const consumer = {
    kind: 'alpha_revision_v1',
    subscriptionId: input.subscriptionId,
    s3JobId: revision.jobId,
    headSha: targetSha,
    baseSha: baselineSha,
  };
  const managed = await control({ action: 'prepare', consumer });
  const descriptor = service.resolve(managed.jobId);
  const powerEvidence = join(dataRoot, 'power.json');
  writeFileSync(powerEvidence, JSON.stringify({ version: 1, confirmedSleep: [] }));
  const raw = rawDurableGateRecord(descriptor);
  assert.equal(
    writeDurableGateRecord(
      {
        ...descriptor,
        ...(options.wallSlaMs ? { wallSlaMs: options.wallSlaMs } : {}),
        recovery: {
          ...descriptor.recovery,
          ...options.recovery,
          powerEvidenceSource: { kind: 'json_file', path: powerEvidence },
        },
      },
      raw,
    ),
    true,
  );
  assert.equal(service.resolve(managed.jobId).recovery.powerEvidenceSource.kind, 'json_file');
  store.bindManagedJob(targetSha, revision.jobId, managed.jobId);
  store.close();
  const verificationPlan = {
    schemaVersion: 1,
    scope: 'browser',
    status: 'ready',
    mode: 'alpha',
    planFingerprint: createHash('sha256').update('private-one-unit-verification').digest('hex'),
    testedHeadSha: targetSha,
    baseSha: baselineSha,
    smokeBudgetMs: 15000,
    requiredUnitIds: Object.keys(sources).map((name) => `browser:${name}`),
    units: Object.keys(sources).map((name) => ({
      unitId: `browser:${name}`,
      lane: 'smoke',
      testPath: name,
      command: {
        cwd: '.',
        argv: [process.execPath, ...(name.endsWith('.test.mjs') ? ['--test'] : []), name],
        env: { NODE_ENV: 'test', CAT_CAFE_DEPLOYMENT_ID: 'test', REDIS_URL: 'redis://127.0.0.1:6398' },
      },
      preparations: [],
    })),
  };
  const priorOwner = process.env.CAT_CAFE_MANAGED_JOB_ID;
  process.env.CAT_CAFE_MANAGED_JOB_ID = managed.jobId;
  try {
    if (options.materializationExitCode !== undefined) {
      verificationPlan.materialization = alphaBrowserMaterializationContract();
      const { planFingerprint: _old, ...core } = verificationPlan;
      verificationPlan.planFingerprint = verificationFingerprint(core);
      executionApi.reserveGateExecutionMaterialization({ ...input, jobId: revision.jobId, verificationPlan });
    } else
      executionApi.submitGateExecution({
        ...input,
        jobId: revision.jobId,
        executionPlan: executionApi.createBrowserGateExecutionPlan({
          repoRoot,
          verificationPlan,
          effectiveEnv: { ...process.env, CAT_CAFE_ALPHA_RECOVERY_JOURNAL: powerEvidence },
        }),
      });
  } finally {
    if (priorOwner === undefined) delete process.env.CAT_CAFE_MANAGED_JOB_ID;
    else process.env.CAT_CAFE_MANAGED_JOB_ID = priorOwner;
  }
  const tasks = new Map(),
    delivered = [];
  const transportPid = join(parent, 'transport.pid');
  const workerPath = join(parent, 'transport.mjs');
  if (options.observeTransport)
    writeFileSync(
      workerPath,
      `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(transportPid)}, String(process.pid));
    await import(${JSON.stringify(new URL('../../../../scripts/lib/alpha-browser-worker.mjs', import.meta.url).href)});`,
    );
  const template = createAlphaBrowserTemplate({
    repoRoot,
    ownerUserId: principal.userId,
    tasks: {
      getBySubject: (key) => tasks.get(key) ?? null,
      upsertBySubject: (draft) => {
        const task = { ...draft, id: `task-${tasks.size + 1}` };
        tasks.set(draft.subjectKey, task);
        return task;
      },
    },
    isAvailable: () => true,
    getEngagementPolicy: () => undefined,
    resolveCat: (value) => (value === principal.catId ? value : null),
    inspectMain: async () => ({ targetSha, databasePath: input.databasePath, legacyLockPath: input.legacyLockPath }),
    ...(options.observeTransport
      ? {
          loadRuntime: async () => ({
            alphaBrowserFailureTasks,
            runAlphaBrowserRevision: (input) => runAlphaBrowserProcess({ ...input, workerPath }),
          }),
        }
      : {}),
  });
  const spec = template.createSpec(input.subscriptionId, {
    trigger: { type: 'cron', expression: '*/5 * * * *' },
    deliveryThreadId: principal.threadId,
    params: { baselineSha, guardianCatId: principal.catId, executionCarrier: 'managed' },
  });
  assert.equal((await spec.admission.gate({ taskId: spec.id })).run, true);
  const run = async (signal = new AbortController().signal) => {
    try {
      await spec.run.execute('alpha', 'alpha', { signal, deliver: async (message) => delivered.push(message) });
    } catch (error) {
      throw new Error(
        `${error.message}\n${JSON.stringify(service.get(principal, managed.jobId))}\n${service.tail(principal, managed.jobId)}`,
        { cause: error },
      );
    }
  };
  return {
    parent,
    repoRoot,
    dataRoot,
    input,
    marker,
    service,
    managed,
    descriptor: service.resolve(managed.jobId),
    powerEvidence,
    run,
    spec,
    revision,
    tasks,
    delivered,
    principal,
    transportPid,
    installLog,
  };
}

export async function until(check, label, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
