/**
 * #1838 RED/GREEN: a provider that really started, then a real Windows API process that really
 * died, then a restart that must let the original session continue.
 *
 * This is not a synthetic store-only test. It spawns a real provider process tree, records its
 * real Win32 identity, kills the owning process for real, and then asks the recovery path whether
 * the original thread/cat may run again. The old code fails at "unconfirmed child stays blocked";
 * it must not fail at fixture setup.
 *
 * Run on Windows: node --test test/windows-provider-restart-recovery.test.js
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const isWindows = process.platform === 'win32';

/** A provider stand-in that really runs and really has a child of its own. */
function spawnProviderTree(scriptDir) {
  writeFileSync(
    join(scriptDir, 'provider.js'),
    [
      "const { spawn } = require('node:child_process');",
      "const path = require('node:path');",
      "const fs = require('node:fs');",
      "const c = spawn(process.execPath, [path.join(__dirname, 'worker.js')], { stdio: 'ignore' });",
      "fs.writeFileSync(path.join(__dirname, 'tree.json'), JSON.stringify({ root: process.pid, child: c.pid }));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  writeFileSync(join(scriptDir, 'worker.js'), 'setInterval(() => {}, 1000);');
  return spawn(process.execPath, [join(scriptDir, 'provider.js')], { stdio: 'ignore', windowsHide: true });
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture file did not appear: ${path}`);
}

async function isAlive(pid, readWindowsProcessTable) {
  const table = await readWindowsProcessTable([pid]);
  return table?.has(pid) === true;
}

async function killExactPid(pid) {
  // Kill ONLY this fixture's own recorded PID, never by image name.
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { readWindowsProcessTable } = await import('../dist/utils/windows-cli-child-owner.js');
    const table = await readWindowsProcessTable([pid]);
    if (table && !table.has(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  'a real stopped Windows provider unblocks the original session after a real restart',
  { skip: !isWindows, timeout: 120_000 },
  async () => {
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const { TurnExecutionStartupReconciler } = await import(
      '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
    );
    const { hasUnconfirmedProviderTeardown } = await import(
      '../dist/domains/cats/services/stores/ports/TurnExecutionStore.js'
    );
    const {
      probeWindowsStopEvidence,
      readWindowsChildOwnerRecords,
      readWindowsProcessTable,
      recordWindowsChildOwner,
    } = await import('../dist/utils/windows-cli-child-owner.js');

    const scriptDir = mkdtempSync(join(tmpdir(), 'issue1838-fixture-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-data-'));
    const execution = {
      executionId: 'parent-exec-1',
      invocationId: 'child-exec-1',
      threadId: 'thread-1',
      catId: 'codex',
      userId: 'user-1',
    };

    let providerRoot;
    try {
      // --- API A: a provider really starts, and its identity is recorded before it can write ---
      const provider = spawnProviderTree(scriptDir);
      provider.on('error', () => {});
      const tree = await waitForFile(join(scriptDir, 'tree.json'));
      providerRoot = tree.root;
      assert.equal(typeof providerRoot, 'number');

      const table = await readWindowsProcessTable([providerRoot]);
      assert.ok(table, 'the Win32 process table must be readable');
      const identity = table.get(providerRoot);
      assert.ok(identity, 'the provider root must exist while it runs');
      const rootIdentity = { pid: identity.pid, creationDate: identity.creationDate };
      assert.ok(rootIdentity.creationDate.length > 0);

      recordWindowsChildOwner({ dataDir, execution, root: rootIdentity });
      const recorded = readWindowsChildOwnerRecords(dataDir);
      assert.equal(recorded.records.length, 1, 'the owner record must be durable before teardown');
      assert.equal(recorded.invalidPaths.length, 0);

      const store = new InMemoryTurnExecutionStore();
      store.createRunning({
        invocationId: execution.invocationId,
        parentInvocationId: execution.executionId,
        threadId: execution.threadId,
        userId: execution.userId,
        catId: execution.catId,
        executionKind: 'ordinary',
        startedAt: 0,
        providerLifecycleTracked: true,
      });
      assert.equal(store.markProviderStarted(execution.invocationId, 1), true);
      assert.equal(hasUnconfirmedProviderTeardown(store.get(execution.invocationId)), true);

      // --- the provider is genuinely alive now: recovery must NOT unblock it ---
      const aliveEvidence = await probeWindowsStopEvidence([rootIdentity]);
      assert.equal(aliveEvidence.verdict, 'alive', 'a running provider must never read as stopped');
      assert.ok(aliveEvidence.liveProcessIds.includes(providerRoot));

      // --- API A dies for real (provider tree included), leaving the ledger behind ---
      await killExactPid(providerRoot);
      assert.equal(await isAlive(providerRoot, readWindowsProcessTable), false);

      // --- API B: a restart with the same durable store ---
      const stoppedEvidence = await probeWindowsStopEvidence([rootIdentity]);
      assert.equal(
        stoppedEvidence.verdict,
        'verified-stopped',
        `the killed provider must read as verified-stopped, got ${JSON.stringify(stoppedEvidence)}`,
      );

      store.recordProviderTeardown(execution.invocationId, Date.now());
      const reconciler = new TurnExecutionStartupReconciler({
        store,
        now: () => Date.now(),
        settleEndedTurnResponse: async (turn) => store.clearResponsePending(turn.invocationId),
      });
      const recovery = await reconciler.reconcile({ processStartedAt: Date.now() + 1 });
      assert.deepEqual(recovery.invocationIds, [execution.invocationId]);
      assert.equal(store.get(execution.invocationId).status, 'interrupted');
      assert.equal(hasUnconfirmedProviderTeardown(store.get(execution.invocationId)), false);
      assert.deepEqual(
        store.listRunningByUser(execution.userId).map((record) => record.invocationId),
        [],
        'the original session must not stay blocked',
      );
    } finally {
      if (providerRoot) {
        const provider = await import('../dist/utils/windows-cli-child-owner.js').then((m) =>
          m.readWindowsProcessTable([providerRoot]),
        );
        if (provider?.has(providerRoot)) await killExactPid(providerRoot);
      }
      rmSync(scriptDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test('a live descendant keeps the execution blocked even after its root exits', { timeout: 20_000 }, async () => {
  const { classifyWindowsStopEvidence } = await import('../dist/utils/windows-cli-child-owner.js');
  // A stale-PPID descendant is exactly what Windows leaves behind, so "root is gone" alone must
  // never resolve to verified-stopped.
  const roots = [{ pid: 1000, creationDate: '100' }];
  const fullTable = new Map([
    [2000, { pid: 2000, ppid: 1000, creationDate: '200' }],
    [3000, { pid: 3000, ppid: 2000, creationDate: '300' }],
  ]);
  const verdict = classifyWindowsStopEvidence(roots, new Map(), { fullTable });
  assert.equal(verdict.verdict, 'alive');
  assert.deepEqual(verdict.liveProcessIds.sort(), [2000, 3000]);
});

test('PID reuse is unknown, not stopped and not someone else s live tree', { timeout: 20_000 }, async () => {
  const { classifyWindowsStopEvidence } = await import('../dist/utils/windows-cli-child-owner.js');
  // The recorded PID now belongs to a different process: our provider is gone, but its former
  // descendants cannot be told apart from the new process's children.
  const roots = [{ pid: 1000, creationDate: '100' }];
  const table = new Map([[1000, { pid: 1000, ppid: 1, creationDate: '999' }]]);
  const verdict = classifyWindowsStopEvidence(roots, table);
  assert.equal(verdict.verdict, 'unknown');
  assert.deepEqual(verdict.liveProcessIds, [], 'must never hand back another tree s PIDs');
});

test('a probe that cannot run is unknown, never stopped', { timeout: 20_000 }, async () => {
  const { classifyWindowsStopEvidence } = await import('../dist/utils/windows-cli-child-owner.js');
  const roots = [{ pid: 1000, creationDate: '100' }];
  assert.equal(classifyWindowsStopEvidence(roots, null).verdict, 'unknown');
  assert.equal(classifyWindowsStopEvidence(roots, new Map(), { fullTable: null }).verdict, 'unknown');
});
