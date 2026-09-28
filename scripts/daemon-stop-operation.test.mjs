import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { probeRecordedApiPort } from './lib/daemon-health-probe.mjs';
import { daemonStatePaths, writeDaemonState } from './lib/daemon-state.mjs';
import {
  authorizeRestart,
  executeStop,
  readStopOperation,
  recordRestart,
  requestStop,
  reverifyStop,
} from './lib/daemon-stop-operation.mjs';
import { descendantPids } from './lib/process-tree.mjs';

/**
 * F300 Task 1.4 -- the stop/restart operation record.
 *
 * Nothing in this file may touch a real deployment: every process here is a
 * disposable child of this test, and every path is a temp dir. Proving that we
 * refuse to stop ourselves must never require stopping anything real.
 */

const roots = new Set();
const children = new Set();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((done) => child.once('exit', done));
    }
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'f300-stop-op-'));
  roots.add(root);
  const homeDir = join(root, 'home');
  const projectRoot = join(root, 'deployment');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const launchToken = 'token-f300';
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  children.add(child);
  await new Promise((done, fail) => {
    child.once('spawn', done);
    child.once('error', fail);
  });

  const paths = daemonStatePaths({ homeDir, projectRoot, deploymentId: 'testdep' });
  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot,
    deploymentId: 'testdep',
    launchToken,
    logFile: join(projectRoot, 'daemon.log'),
    ports: { api: 39002 },
  });

  /**
   * Bring the deployment back the way the launch scripts do: a new process,
   * recorded through the canonical writer. Handing the record an arbitrary live
   * pid is not a restart, and no longer passes for one.
   */
  async function restart() {
    const replacement = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
      { cwd: projectRoot, stdio: 'ignore' },
    );
    children.add(replacement);
    await new Promise((done, fail) => {
      replacement.once('spawn', done);
      replacement.once('error', fail);
    });
    writeDaemonState({
      paths,
      pid: replacement.pid,
      projectRoot,
      deploymentId: 'testdep',
      launchToken,
      logFile: join(projectRoot, 'daemon.log'),
      ports: { api: 39002 },
    });
    return replacement.pid;
  }

  return {
    paths,
    projectRoot,
    child,
    restart,
    owner: { paths, expectedProjectRoot: projectRoot, expectedDeploymentId: 'testdep' },
  };
}

/** The typed `reason` is the contract; the message is prose for humans. */
const hasReason = (reason) => (error) => error.reason === reason;

const request = (owner, overrides = {}) =>
  requestStop({ ...owner, invocationRef: 'invocation:i1', executorPid: process.pid, ...overrides });

describe('StopOperationRecord: state transitions', () => {
  it('opens a record in requested and carries the target process set', async () => {
    const { owner, child } = await fixture();
    const record = request(owner);

    assert.equal(record.state, 'requested');
    assert.deepEqual(record.targetProcessSet, [child.pid]);
    assert.ok(record.opId);
    assert.equal(record.requestedBy.invocationRef, 'invocation:i1');
  });

  it('walks requested to stopping to stopped once the process set is gone', async () => {
    const { owner } = await fixture();
    const { opId } = request(owner);
    const record = await executeStop({ ...owner, opId });

    assert.equal(record.state, 'stopped');
    assert.deepEqual(
      record.history.map((entry) => entry.state),
      ['requested', 'stopping', 'stopped'],
    );
  });

  it('requires explicit user authorization before a restart may be recorded', async () => {
    const { owner } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });

    assert.throws(() => recordRestart({ ...owner, opId, pid: process.pid }), hasReason('restart-not-authorized'));

    const authorized = authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
    assert.equal(authorized.state, 'restart_authorized');
    assert.equal(authorized.restart.authorizedBy, 'user:operator');
  });

  it('reaches reverified only after a healthy restart is observed', async () => {
    const { owner, restart } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
    const restartedPid = await restart();
    const restarted = recordRestart({ ...owner, opId, pid: restartedPid });
    assert.equal(restarted.state, 'restarted');

    const reverified = await reverifyStop({
      ...owner,
      opId,
      probeHealth: () => ({ ok: true, ref: 'http://127.0.0.1:3004/health' }),
    });
    assert.equal(reverified.state, 'reverified');
    // The ref is the probe's own evidence, not something the caller handed in.
    assert.equal(reverified.reverification.ref, 'http://127.0.0.1:3004/health');
  });

  // Reviewed 2026-09-07 (codex-astra, R8): a live pid is not this deployment.
  it('refuses to call an unrelated live process our restart', async () => {
    const { owner } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });

    const record = recordRestart({ ...owner, opId, pid: process.pid });
    assert.equal(record.state, 'failed');
    assert.equal(record.failure.reason, 'restart_process_unverifiable');
  });

  it('clears a stale record instead of treating a dead daemon as running', async () => {
    const { owner, child } = await fixture();
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));

    assert.equal(request(owner).state, 'stale_cleared');
  });

  it('is terminal once failed: nothing revives it', async () => {
    const { owner } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    await reverifyStop({ ...owner, opId, probeHealth: () => ({ ok: false, ref: 'http://127.0.0.1:3004/health' }) });

    assert.equal(readStopOperation(owner.paths).state, 'failed');
    assert.throws(
      () => authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' }),
      hasReason('operation-failed'),
    );
  });
});

/**
 * Reviewed 2026-09-07 (codex-astra, R4): completeness has to be reported, and
 * reporting it must not make ordinary trees look incomplete.
 */
describe('process tree enumeration', () => {
  it('calls a genuinely childless process complete', () => {
    assert.deepEqual(descendantPids(4242, { readChildren: () => [] }), { pids: [], complete: true });
  });

  it('calls a finite tree it walked to the end complete', () => {
    const tree = { 100: [200, 300], 200: [400], 300: [], 400: [] };
    const enumerated = descendantPids(100, { readChildren: (pid) => tree[pid] ?? [] });

    assert.deepEqual(
      enumerated.pids.sort((a, b) => a - b),
      [200, 300, 400],
    );
    assert.equal(enumerated.complete, true);
  });

  it('reports incomplete when a branch could not be read', () => {
    const enumerated = descendantPids(100, {
      readChildren: (pid) => (pid === 100 ? [200] : undefined),
    });

    assert.deepEqual(enumerated.pids, [200]);
    assert.equal(enumerated.complete, false);
  });
});

describe('StopOperationRecord: invariants', () => {
  it('INV-1 refuses when the executor is inside the process set it would stop', async () => {
    const { owner, child } = await fixture();
    assert.throws(() => request(owner, { executorPid: child.pid }), hasReason('executor-in-target-set'));
  });

  it('INV-2 completes the post-stop chain with no API or callback channel reachable', async () => {
    const { owner, restart } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });

    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('the API this cat used to talk to is gone; that must not matter here');
    };
    try {
      authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
      recordRestart({ ...owner, opId, pid: await restart() });
      assert.equal(
        (await reverifyStop({ ...owner, opId, probeHealth: () => ({ ok: true, ref: 'http://127.0.0.1:3004/health' }) }))
          .state,
        'reverified',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('INV-3 keeps one opId across stop, restart and reverify, and rejects a foreign one', async () => {
    const { owner } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
    recordRestart({ ...owner, opId, pid: process.pid });

    await assert.rejects(
      reverifyStop({
        ...owner,
        opId: 'op-someone-else',
        probeHealth: () => ({ ok: true, ref: 'http://127.0.0.1:3004/health' }),
      }),
      hasReason('op-id-mismatch'),
    );
    const record = readStopOperation(owner.paths);
    assert.ok(record.history.every((entry) => entry.opId === opId));
  });

  it('INV-4 does not mistake a stale record for an active operation', async () => {
    const { owner, child } = await fixture();
    request(owner);
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));

    // A new request must be able to open, rather than being blocked forever by
    // a record whose processes are already gone.
    assert.equal(request(owner).state, 'stale_cleared');
  });

  it('INV-5 keeps the record writers inside the daemon module', () => {
    const source = readFileSync(new URL('./lib/daemon-stop-operation.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\(|node:http|axios/);
  });
});

describe('StopOperationRecord: the script entry point goes through the record', () => {
  it('records the whole stop when driven through the daemon-state CLI', async () => {
    const { owner, projectRoot, paths, child } = await fixture();
    const home = join(projectRoot, '..', 'home');
    const result = spawnSync(
      process.execPath,
      [
        new URL('./daemon-state.mjs', import.meta.url).pathname,
        'stop',
        '--project-root',
        projectRoot,
        '--deployment-id',
        'testdep',
        '--home',
        home,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const record = readStopOperation(paths);
    assert.equal(record.state, 'stopped');
    assert.deepEqual(record.targetProcessSet, [child.pid]);
    assert.equal(readStopOperation(owner.paths).opId, record.opId);
  });
});

describe('StopOperationRecord: adversarial', () => {
  it('converges a crashed stop to stopped instead of killing twice', async () => {
    const { owner, child } = await fixture();
    const { opId } = request(owner);
    // Executor dies mid-stop: record still says stopping, processes already gone.
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));

    let killCalls = 0;
    const record = await executeStop({
      ...owner,
      opId,
      stop: async () => {
        killCalls += 1;
        return { outcome: 'stale-cleared' };
      },
    });

    assert.equal(record.state, 'stopped');
    assert.equal(killCalls, 0, 'a process set that is already gone must not be signalled again');
  });

  // Reviewed 2026-09-07 (codex-astra, R5): the race fix must not work by
  // disabling recovery. A single legitimate recoverer, arriving after the
  // previous executor died, still has to be able to take the operation on.
  it('lets one legitimate recoverer take over from a dead executor', async () => {
    const { owner, paths } = await fixture();
    const { opId } = request(owner);

    // A crashed executor's claim: a pid that is provably gone.
    writeFileSync(join(paths.namespaceDir, 'stop-operation.claim'), JSON.stringify({ pid: 2147483647, at: 1 }));

    const record = await executeStop({ ...owner, opId });
    assert.equal(record.state, 'stopped');
  });

  it('refuses a second concurrent stop against the same process set', async () => {
    const { owner } = await fixture();
    request(owner);
    assert.throws(() => request(owner, { invocationRef: 'invocation:i2' }), hasReason('stop-already-in-progress'));
  });

  it('detects a bypass kill: the record says stopping, but nobody went through us', async () => {
    const { owner, child } = await fixture();
    const { opId } = request(owner);
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));

    const record = await reverifyStop({
      ...owner,
      opId,
      probeHealth: () => ({ ok: true, ref: 'http://127.0.0.1:3004/health' }),
    });
    assert.equal(record.state, 'failed');
    assert.equal(record.failure.reason, 'bypass_detected');
  });

  it('does not claim recovery when the restarted daemon is not healthy', async () => {
    const { owner, restart } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
    recordRestart({ ...owner, opId, pid: await restart() });

    const record = await reverifyStop({
      ...owner,
      opId,
      probeHealth: () => ({ ok: false, ref: 'http://127.0.0.1:3004/health' }),
    });
    assert.equal(record.state, 'failed');
    assert.equal(record.failure.reason, 'reverification_failed');
  });

  it('does not close the record when the health probe could not be attempted', async () => {
    const { owner, restart } = await fixture();
    const { opId } = request(owner);
    await executeStop({ ...owner, opId });
    authorizeRestart({ ...owner, opId, authorizedBy: 'user:operator' });
    recordRestart({ ...owner, opId, pid: await restart() });

    const record = await reverifyStop({ ...owner, opId, probeHealth: () => undefined });
    assert.equal(record.state, 'failed');
    assert.equal(record.failure.reason, 'health_unreadable');
  });

  const restartedOperation = async () => {
    const setup = await fixture();
    const { opId } = request(setup.owner);
    await executeStop({ ...setup.owner, opId });
    authorizeRestart({ ...setup.owner, opId, authorizedBy: 'user:operator' });
    const pid = await setup.restart();
    recordRestart({ ...setup.owner, opId, pid });
    return { ...setup, opId, pid };
  };

  for (const timing of ['before', 'after']) {
    it(`reports unreadable identity ${timing} the health probe without claiming absence`, async (t) => {
      const { owner, opId, pid } = await restartedOperation();
      const original = childProcess.execFileSync;
      let unreadable = timing === 'before';
      let probes = 0;
      const mocked = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        if (unreadable && command === 'ps' && args.includes(String(pid)) && args.includes('ucomm=')) {
          throw Object.assign(new Error('identity field unavailable'), { code: 'EACCES' });
        }
        return original(command, args, options);
      });
      syncBuiltinESMExports();
      try {
        const record = await reverifyStop({
          ...owner,
          opId,
          probeHealth: async () => {
            probes += 1;
            unreadable = true;
            return { ok: true, ref: 'fixture:healthy-before-read-failure' };
          },
        });
        assert.equal(record.state, 'failed');
        assert.equal(record.failure.reason, 'restarted_identity_unreadable');
        assert.equal(probes, timing === 'before' ? 0 : 1);
        process.kill(pid, 0);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }

  // Reviewed 2026-09-14 (codex-astra, #4545 R4a): a live timer-only incarnation
  // plus a healthy stranger on its recorded port is not a recovered deployment.
  it('does not accept health served by a listener the incarnation does not own', async () => {
    const stranger = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise((ready) => stranger.listen(0, '127.0.0.1', ready));
    try {
      const { owner, opId, paths, projectRoot, pid } = await restartedOperation();
      // Same incarnation, now recorded against the port a stranger (this test process) serves.
      writeDaemonState({
        paths,
        pid,
        projectRoot,
        deploymentId: 'testdep',
        launchToken: 'token-f300',
        logFile: join(projectRoot, 'daemon.log'),
        ports: { api: stranger.address().port },
      });

      const record = await reverifyStop({ ...owner, opId });
      assert.equal(record.state, 'failed', `a stranger's health closed the record: ${JSON.stringify(record)}`);
    } finally {
      await new Promise((done) => stranger.close(done));
    }
  });

  // Reviewed 2026-09-14 (codex-astra, #4545 R4b): the probe awaits, so nothing
  // read before it may be trusted when its answer arrives.
  it('does not let a late health answer overwrite a newer operation', async () => {
    const { owner, opId, paths } = await restartedOperation();
    let entered;
    let finish;
    const started = new Promise((done) => {
      entered = done;
    });
    const answer = new Promise((done) => {
      finish = done;
    });
    const pending = reverifyStop({
      ...owner,
      opId,
      probeHealth: async () => {
        entered();
        return answer;
      },
    });
    await started;
    const successor = request(owner, { invocationRef: 'invocation:successor' });
    assert.notEqual(successor.opId, opId);
    finish({ ok: true, ref: 'fixture:late-healthy-answer' });
    await pending;
    assert.equal(readStopOperation(paths).opId, successor.opId, 'the late answer overwrote the newer operation');
  });

  it('does not record recovery for an incarnation that exited while the probe was pending', async () => {
    const { owner, opId, pid } = await restartedOperation();
    const record = await reverifyStop({
      ...owner,
      opId,
      probeHealth: async () => {
        const replacement = [...children].find((child) => child.pid === pid);
        const exited = new Promise((done) => replacement.once('exit', done));
        replacement.kill('SIGKILL');
        await exited;
        return { ok: true, ref: 'fixture:answer-after-exit' };
      },
    });
    assert.equal(record.state, 'failed');
    assert.equal(record.failure.reason, 'restarted_process_absent');
  });

  it('still records recovery when the incarnation is alive and answers healthy (positive control)', async () => {
    const { owner, opId, pid } = await restartedOperation();
    let probedFor;
    const record = await reverifyStop({
      ...owner,
      opId,
      probeHealth: async (_state, { incarnationPid }) => {
        probedFor = incarnationPid;
        return { ok: true, ref: 'fixture:healthy' };
      },
    });
    assert.equal(probedFor, pid, 'the probe must be bound to the recorded incarnation');
    assert.equal(record.state, 'reverified');
    assert.equal(record.reverification.pid, pid);
  });
});

/**
 * The default probe, exercised for real.
 *
 * Everything above injects `probeHealth`, which proves the record layer reacts
 * correctly to each answer but would keep passing if the probe itself always
 * said yes. These run it against this test's own servers on ephemeral ports;
 * no real deployment and no sanctuary port is involved.
 */
describe('probeRecordedApiPort: the evidence the record layer produces itself', () => {
  const servers = new Set();

  const serve = async (handler) => {
    const server = createServer(handler);
    servers.add(server);
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    return server.address().port;
  };

  afterEach(async () => {
    for (const server of servers) await new Promise((done) => server.close(done));
    servers.clear();
  });

  const json =
    (body, code = 200) =>
    (_req, res) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  // The HTTP half, with ownership pinned to this process (which serves these ports).
  const ownedBy = (pid) => ({ incarnationPid: pid, readListeners: () => [pid] });
  const probe = (port, options = ownedBy(process.pid)) => probeRecordedApiPort({ ports: { api: port } }, options);

  it('passes when the incarnation owns the port and it answers healthy', async () => {
    const port = await serve(json({ status: 'ok' }));
    assert.deepEqual(await probe(port), { ok: true, ref: `http://127.0.0.1:${port}/health` });
  });

  it('passes against the real listener table when this process owns the port', async () => {
    const port = await serve(json({ status: 'ok' }));
    const health = await probeRecordedApiPort({ ports: { api: port } }, { incarnationPid: process.pid });
    // Without lsof there is no ownership answer, and that must not read as a pass either.
    if (health !== undefined) assert.equal(health.ok, true);
  });

  it('fails when the endpoint answers that it is not', async () => {
    const port = await serve(json({ status: 'degraded' }));
    assert.equal((await probe(port)).ok, false);
  });

  it('fails on an error status even if the body looks healthy', async () => {
    const port = await serve(json({ status: 'ok' }, 503));
    assert.equal((await probe(port)).ok, false);
  });

  it('fails when something is listening but is not serving health', async () => {
    // A bound socket is what a still-initialising daemon looks like. Accepting
    // the connection must not be read as "it came back".
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    });
    assert.equal((await probe(port)).ok, false);
  });

  it('fails when nothing is listening at all', async () => {
    const port = await serve(json({ status: 'ok' }));
    for (const server of servers) await new Promise((done) => server.close(done));
    servers.clear();
    assert.equal((await probe(port, { incarnationPid: process.pid, readListeners: () => [] })).ok, false);
    assert.equal((await probe(port)).ok, false);
  });

  it('fails -- without asking -- when a listener does not belong to the incarnation', async () => {
    const port = await serve(json({ status: 'ok' }));
    let fetched = false;
    const health = await probe(port, {
      incarnationPid: process.pid,
      readListeners: () => [process.pid, 2147483646],
      isDescendant: (pid) => pid === process.pid,
      fetchImpl: async () => {
        fetched = true;
        throw new Error('must not be asked');
      },
    });
    assert.deepEqual(health, { ok: false, ref: `http://127.0.0.1:${port}/health`, reason: 'listener_not_incarnation' });
    assert.equal(fetched, false);
  });

  it('fails when the port changes hands while the answer is in flight', async () => {
    const port = await serve(json({ status: 'ok' }));
    let reads = 0;
    const health = await probe(port, {
      incarnationPid: process.pid,
      readListeners: () => (++reads === 1 ? [process.pid] : [2147483646]),
      isDescendant: (pid) => pid === process.pid,
    });
    assert.equal(health.ok, false);
    assert.equal(health.reason, 'listener_not_incarnation');
  });

  // Reviewed 2026-09-14 (codex-astra, #4545 R2): ownership is proven for the
  // recorded port only, so the answer must come from that port. A redirect to a
  // healthy stranger used to be followed and reported under the recorded ref.
  it('refuses a redirect, never asking the listener it points at', async () => {
    let strangerAsked = 0;
    const strangerPort = await serve((_req, res) => {
      strangerAsked += 1;
      json({ status: 'ok' })(_req, res);
    });
    const source = [
      "const http = require('node:http');",
      'const server = http.createServer((_req, res) => {',
      '  res.writeHead(302, { location: process.argv[1] });',
      '  res.end();',
      '});',
      "server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));",
    ].join('\n');
    const owner = spawn(process.execPath, ['-e', source, `http://127.0.0.1:${strangerPort}/health`], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.add(owner);
    const port = await new Promise((done, fail) => {
      owner.once('message', (message) => done(message.port));
      owner.once('error', fail);
    });

    // Real listener table: the child owns the recorded port, this process owns the stranger's.
    const health = await probeRecordedApiPort({ ports: { api: port } }, { incarnationPid: owner.pid });
    assert.notEqual(health?.ok, true, `redirected health was accepted: ${JSON.stringify(health)}`);
    if (health !== undefined) assert.equal(health.reason, 'redirect_refused');
    assert.equal(strangerAsked, 0, 'the redirect target must never be requested');
  });

  it('asks without following redirects and names a 3xx as refused', async () => {
    let requestInit;
    const health = await probe(39002, {
      incarnationPid: process.pid,
      readListeners: () => [process.pid],
      fetchImpl: async (_url, init) => {
        requestInit = init;
        return { type: 'basic', status: 307, ok: false, json: async () => ({ status: 'ok' }) };
      },
    });
    assert.equal(requestInit.redirect, 'manual');
    assert.deepEqual(health, { ok: false, ref: 'http://127.0.0.1:39002/health', reason: 'redirect_refused' });
  });

  it('returns undefined -- not a pass -- when ownership cannot be read', async () => {
    const port = await serve(json({ status: 'ok' }));
    assert.equal(await probe(port, { incarnationPid: process.pid, readListeners: () => undefined }), undefined);
    assert.equal(
      await probe(port, {
        incarnationPid: process.pid,
        readListeners: () => [process.pid],
        isDescendant: () => undefined,
      }),
      undefined,
    );
  });

  it('returns undefined -- not a failure -- when no port or incarnation was recorded', async () => {
    // Nothing was measured here. That has to stay distinct from a refusal, or
    // an unprobeable record would read as a daemon that answered badly.
    assert.equal(await probeRecordedApiPort({ ports: {} }, { incarnationPid: process.pid }), undefined);
    assert.equal(await probeRecordedApiPort(undefined, { incarnationPid: process.pid }), undefined);
    assert.equal(await probeRecordedApiPort({ ports: { api: 39002 } }), undefined);
  });
});
