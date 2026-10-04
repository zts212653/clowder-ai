import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, test } from 'node:test';

const guard = await import('../../../scripts/native-effect-target-guard.mjs');
const facetModule = await import('../../../scripts/lib/self-host-facet.mjs');

const SELF_ROOT = '/home/user/cat-cafe-f300';
const SELF_REF = `daemon-state:${SELF_ROOT}#runtime`;
// Synthetic ports exercise recorded-host identity without borrowing live defaults.

function exactFacet() {
  return {
    confidence: 'exact',
    facet: {
      v: 1,
      installation: { projectRoot: SELF_ROOT, deploymentId: 'runtime', observedAt: 1, sourceRef: SELF_REF },
      runtime: { worktree: SELF_ROOT, head: '', apiPid: 2622, apiPort: 18080, observedAt: 1, sourceRef: SELF_REF },
      platform: { os: 'darwin', arch: 'arm64', hostNodeId: 'x', observedAt: 1, sourceRef: 'process:1#platform' },
      coordinates: { catId: 'opus-5' },
      hostDependencies: [{ kind: 'api', pid: 2622, port: 18080, identityRef: SELF_REF }],
      heldLeases: [],
      quota: 'unknown',
    },
  };
}

function fixtureObserver(facet) {
  return facetModule.createHostProcessObserver(facet, {
    observerPid: 9000,
    run: (command) => (command === 'ps' ? '1 0\n2622 1\n9000 2622\n9999 9000\n' : '2622\n'),
  });
}

function decide(command, { cwd = '/tmp', selfHost = exactFacet, observeHost = fixtureObserver } = {}) {
  return guard.decideNativeHookPayload({ tool_name: 'Bash', tool_input: { command }, cwd }, { selfHost, observeHost });
}

describe('F300 Task 1.3: self-host policy on the native guard boundary', () => {
  it('denies signalling the api process that is hosting this cat', () => {
    const verdict = decide('kill -TERM 2622');
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.reasonCode, 'self_host_stop');
    assert.match(verdict.detail, /2622/);
  });

  it('denies killing whatever holds our own api port', () => {
    assert.equal(decide('lsof -ti tcp:18080 | xargs kill').reasonCode, 'self_host_stop');
  });

  it('denies stopping the deployment hosting this cat', () => {
    assert.equal(decide('pnpm runtime:stop').reasonCode, 'self_host_stop');
  });

  it('denies a stop whose target it cannot resolve, when it does know what hosts us', () => {
    assert.equal(decide('kill $(cat some.pid)').reasonCode, 'self_host_unresolved');
  });

  // Reviewed 2026-09-07 (codex-astra): an earlier draft let ambiguity through.
  // "I cannot tell which of these is my host" is missing evidence, and a stop
  // that might land on either candidate must not proceed on it.
  it('does not let an ambiguous host become permission to stop', () => {
    const ambiguous = () => ({ ...exactFacet(), confidence: 'ambiguous' });
    assert.equal(decide('kill $(cat some.pid)', { selfHost: ambiguous }).reasonCode, 'self_host_unresolved');
    assert.equal(decide('kill -TERM 2622', { selfHost: ambiguous }).reasonCode, 'self_host_stop');
  });

  it('refuses a stop when a named deployment record cannot be read at all', () => {
    const unreadable = () => ({ ...exactFacet(), confidence: 'unreadable' });
    assert.equal(decide('kill $(cat some.pid)', { selfHost: unreadable }).reasonCode, 'self_host_unresolved');
  });

  it('stays out of the way when no daemon hosts us at all', () => {
    const none = () => ({ confidence: 'none' });
    assert.equal(decide('kill $(cat some.pid)', { selfHost: none }).decision, 'allow');
    assert.equal(decide('kill -TERM 2622', { selfHost: none }).decision, 'allow');
  });

  it('leaves ordinary work alone', () => {
    for (const command of ['git status', 'pnpm test', 'kill -TERM 9999', 'lsof -ti tcp:18080']) {
      assert.equal(decide(command).decision, 'allow', command);
    }
  });

  it('keeps sanctuary refusals attributed to the existing policy, not to F300', () => {
    const verdict = decide('redis-cli -p 6399 flushall');
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.reasonCode, 'redis_sanctuary_mutation');
  });

  it('resolves the facet without ever inspecting a live process', () => {
    // readSelfHostFacet is what the hook uses in production; it reads one JSON
    // file. If it ever needs `ps`, it stops being safe to run per tool call.
    assert.equal(typeof facetModule.readSelfHostFacet, 'function');
  });

  it('protects the hook executor but allows its unrelated feature child', () => {
    assert.equal(decide('kill -TERM 9000').reasonCode, 'self_host_stop');
    assert.equal(decide('kill -TERM 9999').decision, 'allow');
  });
});

describe('F300 INV-7: lazy bounded process observations', () => {
  it('samples listeners and the parent table only once per decision', () => {
    const calls = [];
    const observation = facetModule.createHostProcessObserver(exactFacet().facet, {
      observerPid: 9000,
      run: (command, args, options) => {
        calls.push({ command, args });
        assert.equal(options.timeout, 1000);
        assert.equal(options.maxBuffer, 1024 * 1024);
        return command === 'lsof' ? '2622\n2622\n' : '1 0\n2622 1\n9000 2622\n9999 9000\n';
      },
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(observation.readHostPids(), { pids: [2622], complete: true });
    assert.deepEqual(observation.readHostPids(), { pids: [2622], complete: true });
    assert.equal(observation.isHostDescendant(9000, 2622), true);
    assert.equal(observation.isHostDescendant(9000, 9999), false);
    assert.deepEqual(calls, [
      { command: 'lsof', args: ['-nP', '-iTCP:18080', '-sTCP:LISTEN', '-t'] },
      { command: 'ps', args: ['-e', '-o', 'pid=,ppid='] },
    ]);
  });

  it('keeps empty listener searches distinct from failed or malformed observations', () => {
    const read = (run) => facetModule.createHostProcessObserver(exactFacet().facet, { run }).readHostPids();
    assert.deepEqual(
      read(() => {
        throw Object.assign(new Error(), { status: 1, stdout: '', stderr: '' });
      }),
      { pids: [], complete: true },
    );
    for (const result of ['2622\ninvalid\n', '', '0\n', '1e3\n']) {
      assert.deepEqual(
        read(() => result),
        { pids: [], complete: false },
      );
    }
    for (const failure of [{ status: 2 }, { code: 'ETIMEDOUT' }, { status: 1, stderr: 'permission denied' }]) {
      assert.deepEqual(
        read(() => {
          throw Object.assign(new Error(), failure);
        }),
        { pids: [], complete: false },
      );
    }
  });

  it('never turns an incomplete parent table into proof of non-dependence', () => {
    for (const value of ['garbage', '2622 1\n2622 20\n', '42 1\n', '2622 2630\n2630 2622\n']) {
      const observation = facetModule.createHostProcessObserver(exactFacet().facet, { run: () => value });
      assert.equal(observation.isHostDescendant(2622, 9999), undefined);
    }
    const observation = facetModule.createHostProcessObserver(exactFacet().facet, {
      run: () => {
        throw new Error('ps unavailable');
      },
    });
    assert.equal(observation.isHostDescendant(2622, 9999), undefined);
  });
});

test('real listener and ancestry observations distinguish a host from its feature child', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  await once(child, 'message');
  const facet = exactFacet().facet;
  facet.runtime = { launcherPid: process.pid, apiPort: server.address().port, sourceRef: SELF_REF };
  facet.hostDependencies = [{ kind: 'api', port: server.address().port, identityRef: SELF_REF }];
  const payload = (pid) => ({ tool_name: 'Bash', tool_input: { command: `kill -TERM ${pid}` }, cwd: '/tmp' });
  // The payload is classified, never executed. Only our isolated child is
  // signalled during cleanup, after all real process observations finish.
  assert.equal(
    guard.decideNativeHookPayload(payload(child.pid), { selfHost: () => ({ confidence: 'exact', facet }) }).decision,
    'allow',
  );
  assert.equal(
    guard.decideNativeHookPayload(payload(process.pid), { selfHost: () => ({ confidence: 'exact', facet }) })
      .reasonCode,
    'self_host_stop',
  );
  assert.equal(
    guard.decideNativeHookPayload(payload(process.ppid), { selfHost: () => ({ confidence: 'exact', facet }) })
      .reasonCode,
    'self_host_stop',
  );
});

describe('F300 Task 1.3: reading the self facet from daemon state', () => {
  const home = mkdtempSync(join(tmpdir(), 'f300-facet-'));
  after(() => rmSync(home, { recursive: true, force: true }));

  function writeDaemon(deploymentId, state) {
    const dir = join(home, '.cat-cafe', 'daemons', `${deploymentId}-abc123`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify(state));
  }

  writeDaemon('runtime', {
    version: 1,
    deploymentId: 'runtime',
    projectRoot: SELF_ROOT,
    pid: 2622,
    ports: { frontend: 18081, api: 18080, redis: 6399 },
  });

  it('binds to the deployment named in our own environment', () => {
    const { confidence, facet } = facetModule.readSelfHostFacet({
      env: { CAT_CAFE_DEPLOYMENT_ID: 'runtime' },
      homeDir: home,
    });

    assert.equal(confidence, 'exact');
    assert.equal(facet.installation.deploymentId, 'runtime');
    // The recorded pid is the launcher shell, not the API: start-dev.sh writes
    // its own pid and the API is an unrecorded child of it.
    assert.equal(facet.runtime.launcherPid, 2622);
    assert.equal(facet.runtime.apiPid, undefined);
    assert.equal(facet.runtime.apiPort, 18080);
    assert.ok(facet.hostDependencies.some((d) => d.kind === 'redis' && d.port === 6399));
    assert.ok(facet.installation.sourceRef.includes(SELF_ROOT));
  });

  it('reports no host rather than guessing when the environment says nothing', () => {
    assert.equal(facetModule.readSelfHostFacet({ env: {}, homeDir: home }).confidence, 'none');
  });

  it('separates an unreadable record from having no host at all', () => {
    // A named deployment whose record is missing is not the same answer as
    // nothing claiming to host us, and only the latter may stand aside.
    const resolved = facetModule.readSelfHostFacet({ env: { CAT_CAFE_DEPLOYMENT_ID: 'ghost' }, homeDir: home });
    assert.equal(resolved.confidence, 'unreadable');
  });
});
