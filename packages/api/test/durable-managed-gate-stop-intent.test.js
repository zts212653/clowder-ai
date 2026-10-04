import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDurableManagedGateJob } from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const CHILD_READY_BUDGET_MS = 10000;
async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(setImmediate);
  return existsSync(path);
}

for (const kind of ['timeout', 'cancel'])
  test(`managed ${kind} keeps its cause before child SIGTERM`, { timeout: 30000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-stop-wire-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    const jobId = 'managed-gate-stop-wire';
    const job = {
      kind: 'resumable_full_gate_v2',
      jobId,
      originTaskId: 'task:wire',
      supervisorEpoch: 'stop-wire',
      recordPath: join(root, 'managed-gate-jobs', `${jobId}.json`),
      gateReceiptPath: join(root, 'managed-gate-jobs', `${jobId}.gate.json`),
      logPath: join(root, 'managed-gate-jobs', `${jobId}.log`),
      executionSlaMs: 1000,
      wallSlaMs: CHILD_READY_BUDGET_MS + 5000,
      wakeTarget: { threadId: 'fixture', catId: 'codex-astra', userId: 'fixture' },
      recovery: {
        protocolVersion: 2,
        eventLoopGapMs: 5000,
        reconciliationBudgetMs: CHILD_READY_BUDGET_MS,
        pollMs: 50,
        powerEvidenceSource: { kind: 'json_file', path: join(root, 'power.json') },
      },
    };
    const frozenIdentity = {
      headSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      route: 'full',
      risk: 'contract',
      mode: 'full',
      fingerprint: 'd'.repeat(64),
      runnerFingerprint: 'e'.repeat(64),
      toolchainFingerprint: 'f'.repeat(64),
    };
    const resultPath = join(root, 'observed.json');
    const childPath = join(root, 'child.mjs');
    const childReadyPath = join(root, 'child-ready');
    const runner = new ManagedRunner();
    try {
      initializeDurableManagedGateJob(job, Date.now());
      writeFileSync(
        job.gateReceiptPath,
        JSON.stringify({
          version: 1,
          jobId,
          runId: 'canonical-wire',
          frozenIdentity,
          executionOwner: { jobId, originTaskId: job.originTaskId },
          recovery: { protocolVersion: 2, frozenIdentity },
        }),
      );
      writeFileSync(job.recovery.powerEvidenceSource.path, JSON.stringify({ version: 1, confirmedSleep: [] }));
      writeFileSync(
        childPath,
        `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const consumer=import(${JSON.stringify(new URL('../../../scripts/lib/gate-execution-managed-stop.mjs', import.meta.url).href)});
const readyPath=process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH;
const attemptToken=process.env.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN;
writeFileSync(readyPath,JSON.stringify({version:1,protocolVersion:2,jobId:process.env.CAT_CAFE_MANAGED_JOB_ID,attemptToken,frozenFingerprint:${JSON.stringify(frozenIdentity.fingerprint)}}));
process.on('SIGTERM',async()=>{
 const {captureManagedGateStop}=await consumer;
 const path=readyPath+'.stop-intent.json';
 writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({attemptToken,intent:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null,
 captured:captureManagedGateStop({owner_principal:'managed:'+process.env.CAT_CAFE_MANAGED_JOB_ID, origin_task_id:process.env.CAT_CAFE_GATE_ORIGIN_TASK_ID, created_at:0, plan_json:${JSON.stringify(JSON.stringify({ testedHeadSha: 'a'.repeat(40), baseSha: 'c'.repeat(40) }))}},
 {readyPath,attemptToken,managedJobId:process.env.CAT_CAFE_MANAGED_JOB_ID,originTaskId:process.env.CAT_CAFE_GATE_ORIGIN_TASK_ID},Date.now())}));
 process.exit(0);
});
writeFileSync(${JSON.stringify(childReadyPath)},'ready');
setInterval(()=>{},1000);
`,
      );
      const { completion } = runner.start(`${quote(process.execPath)} ${quote(childPath)}`, {
        managedJob: job,
        timeoutMs: job.wallSlaMs,
        maximumTimeoutMs: job.wallSlaMs,
      });
      assert.ok(await waitForFile(childReadyPath, CHILD_READY_BUDGET_MS), `fixture must start before managed ${kind}`);
      if (kind === 'cancel') runner.cancel();
      const result = await completion;
      assert.ok(await waitForFile(resultPath, 5000), result.tailOutput);
      const observed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (kind === 'cancel') {
        assert.equal(observed.intent, null);
        assert.equal(observed.captured, null);
        assert.ok(existsSync(`${job.recordPath}.cancel-request`));
        return;
      }
      assert.equal(observed.intent?.intent, 'timed_out');
      assert.equal(
        observed.captured?.intent,
        'timed_out',
        'the real S3 consumer must accept the owner-bound producer receipt',
      );
      assert.equal(observed.intent?.attemptToken, observed.attemptToken);
      assert.equal(observed.intent?.runId, 'canonical-wire');
      assert.equal(observed.intent?.frozenIdentity.fingerprint, frozenIdentity.fingerprint);
    } finally {
      runner.cancel();
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
