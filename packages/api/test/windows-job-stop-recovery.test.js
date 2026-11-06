/**
 * #1838: how Windows job stop evidence reaches the TurnExecution owner.
 *
 * Portable: the native query is injected, so every platform checks which verdicts may release an
 * execution and which must keep it protected. The real kernel job and a real restart are covered by
 * windows-job-owner.test.js and windows-job-restart-recovery.test.js.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);
const { hasUnconfirmedProviderTeardown } = await import(
  '../dist/domains/cats/services/stores/ports/TurnExecutionStore.js'
);
const { clearSettledWindowsJobEvidence, recordVerifiedWindowsJobTeardowns, stopWithWindowsJobProof } = await import(
  '../dist/domains/cats/services/agents/invocation/WindowsJobStopRecovery.js'
);
const { recordWindowsJobExecutionLink, resolveWindowsJobLinksDirectory } = await import(
  '../dist/utils/windows-job-execution-links.js'
);
const { queryWindowsJobStopEvidence, resolveWindowsJobDirectory } = await import('../dist/utils/windows-job-owner.js');

const SEP = String.fromCharCode(92);
const JOB = `Local${SEP}ClowderApiJob-recovery-test`;
const answer = (observed) => async () => ({ stdout: `${JSON.stringify(observed)}\r\n`, stderr: '' });
const ABSENT = answer({ state: 'absent', nativeError: 2, sessionId: 1 });

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'issue1838-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(resolveWindowsJobDirectory(dataDir), { recursive: true });
  writeFileSync(
    join(resolveWindowsJobDirectory(dataDir), 'owner.json'),
    JSON.stringify({ v: 1, jobName: JOB, apiPid: 4321, helperPid: 4322, sessionId: 1, createdAt: 1 }),
  );
  const store = new InMemoryTurnExecutionStore();
  const start = (id, { providerStarted = true } = {}) => {
    const execution = {
      executionId: `parent-${id}`,
      invocationId: id,
      threadId: 'thread-1',
      catId: 'codex',
      userId: 'user-1',
    };
    store.createRunning({
      invocationId: id,
      parentInvocationId: execution.executionId,
      threadId: execution.threadId,
      userId: execution.userId,
      catId: execution.catId,
      executionKind: 'ordinary',
      startedAt: 1,
      providerLifecycleTracked: true,
    });
    if (providerStarted) assert.equal(store.markProviderStarted(id, 2), true);
    return execution;
  };
  const link = (execution) => recordWindowsJobExecutionLink({ dataDir, jobName: JOB, execution });
  const reconcile = () =>
    new TurnExecutionStartupReconciler({
      store,
      settleEndedTurnResponse: async (turn) => store.clearResponsePending(turn.invocationId),
    }).reconcile({ processStartedAt: Date.now() + 1 });
  return { dataDir, store, start, link, reconcile };
}

test('only same-session ERROR_FILE_NOT_FOUND is a stop verdict', { timeout: 20_000 }, async () => {
  const record = { jobName: JOB, sessionId: 1 };
  const answer = (observed) => ({ execute: async () => ({ stdout: `${JSON.stringify(observed)}\r\n`, stderr: '' }) });

  const failed = await queryWindowsJobStopEvidence(record, {
    execute: async () => {
      throw new Error('powershell unavailable');
    },
  });
  assert.equal(failed.verdict, 'unknown');
  assert.equal(failed.activeProcesses, 0);
  const unparseable = await queryWindowsJobStopEvidence(record, {
    execute: async () => ({ stdout: 'not json at all', stderr: '' }),
  });
  assert.equal(unparseable.verdict, 'unknown');

  assert.equal(
    (await queryWindowsJobStopEvidence(record, answer({ state: 'absent', nativeError: 2, sessionId: 1 }))).verdict,
    'absent',
  );
  // A `Local\` name does not resolve from another session, so a live job looks absent from there.
  const otherSession = await queryWindowsJobStopEvidence(
    record,
    answer({ state: 'absent', nativeError: 2, sessionId: 2 }),
  );
  assert.equal(otherSession.verdict, 'unknown');
  assert.match(otherSession.reason, /other_session/);
  assert.equal(
    (await queryWindowsJobStopEvidence(record, answer({ state: 'absent', nativeError: 2 }))).verdict,
    'unknown',
  );
  // A bare label or another native code is never proof the owner is gone.
  assert.equal(
    (await queryWindowsJobStopEvidence(record, answer({ state: 'absent', sessionId: 1 }))).verdict,
    'unknown',
  );
  assert.equal(
    (await queryWindowsJobStopEvidence(record, answer({ state: 'absent', nativeError: 5, sessionId: 1 }))).verdict,
    'unknown',
  );
  const present = await queryWindowsJobStopEvidence(
    record,
    answer({ state: 'present', activeProcesses: 2, sessionId: 1 }),
  );
  assert.deepEqual([present.verdict, present.activeProcesses], ['present', 2]);
});

test('a verifiably closed job releases exactly its linked executions, and they settle', async (t) => {
  const { dataDir, store, start, link, reconcile } = fixture(t);
  link(start('child-1'));
  // Started under some other owner with no link: no proof covers it. Since #1849 it still settles
  // through the ordinary Host interruption, but its physical exit stays unknown.
  start('unlinked');

  const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir, execute: ABSENT });
  assert.deepEqual(pass.released, ['child-1'], 'only the linked execution gets a teardown');
  assert.deepEqual(pass.preserved, []);

  const recovery = await reconcile();
  assert.deepEqual([...recovery.invocationIds].sort(), ['child-1', 'unlinked']);
  assert.equal(store.get('child-1').status, 'interrupted');
  assert.equal(store.get('child-1').terminalReason, 'process_restart');
  assert.equal(hasUnconfirmedProviderTeardown(store.get('child-1')), false);
  assert.equal(store.get('unlinked').status, 'interrupted');
  assert.equal(store.get('unlinked').providerTeardownAt, undefined, 'no proof, so no teardown is written');

  assert.deepEqual(await clearSettledWindowsJobEvidence({ store, pass }), { clearedLinks: 1, clearedJobs: 1 });
  assert.deepEqual(readdirSync(resolveWindowsJobDirectory(dataDir)), []);
  assert.deepEqual(readdirSync(resolveWindowsJobLinksDirectory(dataDir)), []);
  // Repeating recovery finds nothing left to prove and changes nothing.
  const again = await recordVerifiedWindowsJobTeardowns({ store, dataDir, execute: ABSENT });
  assert.deepEqual([again.released, again.resolution.verifiedStopped], [[], []]);
});

test('a live, other-session or unknown job releases nothing and names what it protects', async (t) => {
  const verdicts = {
    present: answer({ state: 'present', activeProcesses: 2, sessionId: 1 }),
    otherSession: answer({ state: 'absent', nativeError: 2, sessionId: 2 }),
    otherNativeError: answer({ state: 'absent', nativeError: 5, sessionId: 1 }),
    queryFailed: async () => {
      throw new Error('powershell unavailable');
    },
  };
  for (const [name, execute] of Object.entries(verdicts)) {
    const { dataDir, store, start, link } = fixture(t);
    link(start('child-1'));
    const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir, execute });
    assert.deepEqual(pass.released, [], name);
    assert.equal(pass.preserved[0]?.invocationId, 'child-1', name);
    assert.match(pass.preserved[0].reason, /^job_(present|unknown):/, name);
    assert.equal(hasUnconfirmedProviderTeardown(store.get('child-1')), true, name);
    assert.deepEqual(await clearSettledWindowsJobEvidence({ store, pass }), { clearedLinks: 0, clearedJobs: 0 }, name);
  }
});

test('a link that disagrees with the ledger, or cannot be read, keeps the evidence', async (t) => {
  const { dataDir, store, start, link } = fixture(t);
  const execution = start('child-1');
  link({ ...execution, threadId: 'thread-other' });
  writeFileSync(join(resolveWindowsJobLinksDirectory(dataDir), `${encodeURIComponent(JOB)}.torn.json`), '{"v":1,');

  const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir, execute: ABSENT });
  assert.deepEqual(pass.released, []);
  assert.deepEqual(pass.preserved.map((entry) => entry.reason).sort(), ['link_identity_mismatch', 'link_unreadable']);
  assert.equal(hasUnconfirmedProviderTeardown(store.get('child-1')), true);
  const cleared = await clearSettledWindowsJobEvidence({ store, pass });
  assert.equal(cleared.clearedJobs, 0, 'the owner record stays while any covered link is unsettled');
  assert.equal(readdirSync(resolveWindowsJobDirectory(dataDir)).length, 1);
});

test('this process s own job is never judged', async (t) => {
  const { dataDir, store, start, link } = fixture(t);
  link(start('child-1'));
  const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir, currentJobName: JOB, execute: ABSENT });
  assert.deepEqual([pass.resolution.verifiedStopped, pass.resolution.unresolved, pass.released], [[], [], []]);
});

test('an execution that crashed before its provider started settles without the proof', async (t) => {
  const { dataDir, store, start, link, reconcile } = fixture(t);
  link(start('child-1', { providerStarted: false }));
  const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir, execute: ABSENT });
  assert.deepEqual(pass.released, [], 'no teardown proof is needed when no provider started');
  assert.deepEqual((await reconcile()).invocationIds, ['child-1']);
  assert.deepEqual(await clearSettledWindowsJobEvidence({ store, pass }), { clearedLinks: 1, clearedJobs: 1 });
});

test('Stop ends a dead API s execution only with its exact job proof, and names every refusal', async (t) => {
  // Verifiably closed and linked to exactly this execution: canceled with the proof, link removed.
  const closed = fixture(t);
  closed.link(closed.start('child-1'));
  const stopped = await stopWithWindowsJobProof({
    store: closed.store,
    record: closed.store.get('child-1'),
    dataDir: closed.dataDir,
    execute: ABSENT,
  });
  // The caller settles the ended turn's response next, so the successful stop carries that record.
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.record, closed.store.get('child-1'));
  const record = closed.store.get('child-1');
  assert.deepEqual([record.status, record.terminalReason], ['canceled', 'user_cancel']);
  assert.equal(hasUnconfirmedProviderTeardown(record), false);
  assert.deepEqual(readdirSync(resolveWindowsJobLinksDirectory(closed.dataDir)), []);

  const refusals = {
    present: [answer({ state: 'present', activeProcesses: 2, sessionId: 1 }), /^job_present:/],
    unknown: [
      async () => {
        throw new Error('powershell unavailable');
      },
      /^job_unknown:/,
    ],
    unlinked: [ABSENT, /^no_windows_job_link$/],
    mismatched: [ABSENT, /^link_identity_mismatch$/],
  };
  for (const [name, [execute, reason]] of Object.entries(refusals)) {
    const { dataDir, store, start, link } = fixture(t);
    const execution = start('child-1');
    if (name === 'mismatched') link({ ...execution, threadId: 'another-thread' });
    else if (name !== 'unlinked') link(execution);
    const result = await stopWithWindowsJobProof({ store, record: store.get('child-1'), dataDir, execute });
    assert.equal(result.stopped, false, name);
    assert.match(result.reason, reason, name);
    assert.equal(store.get('child-1').status, 'running', `${name}: the execution keeps its occupancy`);
    assert.equal(hasUnconfirmedProviderTeardown(store.get('child-1')), true, name);
  }
});
