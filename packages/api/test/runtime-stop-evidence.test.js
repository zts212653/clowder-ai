import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { createRuntimeStopProbe, runtimeStopRecordFile, STOP_SIGNAL_WINDOW_MS, stopRecordTargets } = await import(
  '../dist/domains/cats/services/agents/invocation/host-sleep/RuntimeStopEvidence.js'
);
const { daemonStatePaths } = await import('../../../scripts/lib/daemon-state.mjs');
const { recordFile } = await import('../../../scripts/lib/daemon-stop-record.mjs');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

let home;
let projectRoot;
let auditDir;
let originalAuditDir;
let originalPreflightDisable;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'f337-stop-home-'));
  projectRoot = await mkdtemp(join(tmpdir(), 'f337-stop-root-'));
  auditDir = await mkdtemp(join(tmpdir(), 'f337-stop-audit-'));
  originalAuditDir = process.env.AUDIT_LOG_DIR;
  originalPreflightDisable = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  process.env.AUDIT_LOG_DIR = auditDir;
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
});

after(async () => {
  if (originalAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = originalAuditDir;
  if (originalPreflightDisable === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalPreflightDisable;
  for (const dir of [home, projectRoot, auditDir]) await rm(dir, { recursive: true, force: true });
});

async function writeRecord(record) {
  const file = await runtimeStopRecordFile({ projectRoot, deploymentId: 'runtime', homeDir: home });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record));
  return file;
}

describe('F337 runtime stop record', () => {
  // The launcher writes the record; the API reads it. A drift in either path derivation would make the
  // probe silently read nothing.
  test('the API finds the record exactly where the launcher writes it', async () => {
    const ours = await runtimeStopRecordFile({ projectRoot, deploymentId: 'runtime', homeDir: home });
    const launcher = recordFile(daemonStatePaths({ homeDir: home, projectRoot, deploymentId: 'runtime' }));
    assert.equal(ours, launcher);
  });

  // This process instance: pid 42, started at T. The stop signals at T + 10 min.
  const T = Date.parse('2026-11-16T23:02:53Z');
  const signalled = new Date(T + 600_000).toISOString();
  const instance = { pid: 42, startedAt: T };
  const now = T + 600_000 + 1_400;

  test('only a stop that has signalled this process instance, just now, counts', () => {
    const record = (state, pids, at = signalled) => ({ v: 1, state, targetProcessSet: pids, signalledAt: at });
    assert.equal(stopRecordTargets(record('stopping', [1, 42]), instance, now), true);
    assert.equal(
      stopRecordTargets(record('stopping', [1, 2]), instance, now),
      false,
      'another instance is being stopped',
    );
    assert.equal(stopRecordTargets(record('stopped', [42]), instance, now), false, 'a finished stop');
    assert.equal(stopRecordTargets(record('failed', [42]), instance, now), false);
    assert.equal(stopRecordTargets(null, instance, now), false);
  });

  // Watcher review (11-16, PR #7202): requested is written before the executor signals, and an
  // executor that exits in between leaves it in progress while the API keeps running.
  test('a stop requested but never signalled is not a stop', () => {
    assert.equal(stopRecordTargets({ v: 1, state: 'requested', targetProcessSet: [42] }, instance, now), false);
    assert.equal(stopRecordTargets({ v: 1, state: 'stopping', targetProcessSet: [42] }, instance, now), false);
  });

  // Watcher review (11-16, PR #7202): a record left in progress by an earlier boot may list a pid this
  // instance now reuses; and one signalled long ago while this process lives was never carried out.
  test('a record signalled before this process started, or long ago, is not this stop', () => {
    const before = new Date(T - 5_000).toISOString();
    assert.equal(
      stopRecordTargets({ v: 1, state: 'stopping', targetProcessSet: [42], signalledAt: before }, instance, now),
      false,
    );
    assert.equal(
      stopRecordTargets(
        { v: 1, state: 'stopping', targetProcessSet: [42], signalledAt: signalled },
        instance,
        now + STOP_SIGNAL_WINDOW_MS,
      ),
      false,
    );
  });

  test('a record an earlier boot left stopping does not cut this instance, even if it reuses a listed pid', async () => {
    const stale = new Date(T - 5_000).toISOString();
    const file = await writeRecord({ v: 1, state: 'stopping', targetProcessSet: [42], signalledAt: stale });
    const probe = createRuntimeStopProbe({
      begun: () => false,
      recordFile: file,
      pid: 42,
      startedAt: T,
      now: () => now,
    });
    assert.equal(await probe(), false);
  });

  // Review R2 P1 (codex61-sol, PR #7202): SIGTERM can arrive while the record is being read.
  for (const [outcome, read] of [
    ['the read fails', () => Promise.reject(new Error('EIO'))],
    [
      'the record names another instance',
      async () => JSON.stringify({ v: 1, state: 'stopped', targetProcessSet: [7] }),
    ],
  ]) {
    test(`SIGTERM arriving during the record read still counts when ${outcome}`, async () => {
      const flag = { begun: false };
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const probe = createRuntimeStopProbe({
        begun: () => flag.begun,
        recordFile: '/stop-operation.json',
        pid: 42,
        startedAt: T,
        now: () => now,
        read: async () => {
          await gate;
          return read();
        },
      });
      const answer = probe();
      flag.begun = true;
      release();
      assert.equal(await answer, true);
    });
  }

  test('the probe reads the record on demand; unreadable means not stopping', async () => {
    const file = await writeRecord({ v: 1, state: 'stopped', targetProcessSet: [42], signalledAt: signalled });
    const flag = { begun: false };
    const probe = createRuntimeStopProbe({
      begun: () => flag.begun,
      recordFile: Promise.resolve(file),
      pid: 42,
      startedAt: T,
      now: () => now,
    });
    assert.equal(await probe(), false);
    await writeFile(
      file,
      JSON.stringify({ v: 1, state: 'stopping', targetProcessSet: [7, 42], signalledAt: signalled }),
    );
    assert.equal(await probe(), true, 'the record changed after the probe was made');
    await writeFile(file, '{ not json');
    assert.equal(await probe(), false);
    flag.begun = true;
    assert.equal(await probe(), true, 'the SIGTERM flag alone also counts');
    const noRecord = createRuntimeStopProbe({ begun: () => false, recordFile: undefined, pid: 42 });
    assert.equal(await noRecord(), false);
  });
});

// Boot 92 → 93 (11-16 22:32 PST): the launcher walks the tree depth-first, so the provider died and its
// turn ended 1.4 s before the API's own SIGTERM flag could be set. The record was already written.
describe('F337 invokeSingleCat with the launcher signalling providers first', () => {
  async function runCut(invocationId, { signals, probe }) {
    const pid = 4242;
    const file = await writeRecord({ v: 1, state: 'requested', targetProcessSet: [pid] });
    const store = new InMemoryTurnExecutionStore();
    const observed = [];
    const deps = {
      registry: {
        create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      turnExecutionStore: store,
      isRuntimeShuttingDown: probe ?? createRuntimeStopProbe({ begun: () => false, recordFile: file, pid }),
      routingDispatchSignalObserver: {
        async observeTerminal(evidence) {
          observed.push(evidence);
        },
      },
    };
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'codex61-sol', content: '在做了', timestamp: Date.now() };
        if (signals) {
          const signalledAt = new Date().toISOString();
          await writeFile(file, JSON.stringify({ v: 1, state: 'stopping', targetProcessSet: [pid], signalledAt }));
        }
        yield {
          type: 'error',
          catId: 'codex61-sol',
          error: 'Codex app-server stream ended before turn completion',
          errorCode: 'runtime_disconnected',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex61-sol', timestamp: Date.now() };
      },
    };
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'codex61-sol',
      service,
      prompt: 'test',
      userId: 'user-1',
      threadId: 'thread-1',
      parentInvocationId: 'parent-1',
      routingDispatchPreflightDecision: {
        v: 1,
        ownerId: 'user-1',
        observedAt: 1,
        resolverState: 'fresh',
        snapshotRef: 'routing-snapshot:1',
        targets: [{ targetCatId: 'codex61-sol', disposition: 'allowed', reasons: [], alternatives: [] }],
      },
      isLastCat: true,
    })) {
      messages.push(message);
    }
    return { store, observed, messages };
  }

  test('a provider killed before the API heard SIGTERM is still a restart cut, owed to the next boot', async () => {
    const { store, observed, messages } = await runCut('child-first', { signals: true });
    const terminal = await store.get('child-first');
    assert.equal(terminal.terminalReason, 'restart_shutdown');
    assert.equal(messages.find((message) => message.type === 'done')?.errorCode, 'RESTART_SHUTDOWN');
    assert.equal(observed[0].failureClass, undefined);
    assert.deepEqual(
      (await store.listOwedContinuations()).map((record) => record.invocationId),
      ['child-first'],
    );
  });

  test('SIGTERM landing mid-read still makes the provider failure a restart cut in record, reply and debt', async () => {
    const flag = { begun: false };
    const probe = createRuntimeStopProbe({
      begun: () => flag.begun,
      recordFile: '/stop-operation.json',
      pid: 4242,
      read: async () => {
        flag.begun = true;
        throw new Error('EIO');
      },
    });
    const { store, observed, messages } = await runCut('child-midread', { signals: false, probe });
    assert.equal((await store.get('child-midread')).terminalReason, 'restart_shutdown');
    assert.equal(messages.find((message) => message.type === 'done')?.errorCode, 'RESTART_SHUTDOWN');
    assert.equal(observed[0].failureClass, undefined);
    assert.deepEqual(
      (await store.listOwedContinuations()).map((record) => record.invocationId),
      ['child-midread'],
    );
  });

  test('a provider failure while a stop is only requested stays a provider failure', async () => {
    const { store, observed } = await runCut('child-unsignalled', { signals: false });
    assert.equal((await store.get('child-unsignalled')).terminalReason, 'provider_execution_failed');
    assert.equal(observed[0].failureClass, 'provider_unreachable');
    assert.deepEqual(await store.listOwedContinuations(), []);
  });
});
