import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-public-test-distributable.sh', import.meta.url));
const namespaceInit = fileURLToPath(new URL('./public-test-namespace-init.py', import.meta.url));
const commandRunner = new URL('../../packages/api/scripts/redis-test-processes.mjs', import.meta.url).href;
const namespaceProbe = new URL('../../packages/api/scripts/public-test-isolation-preflight.mjs', import.meta.url).href;
const resourceGuard = fileURLToPath(
  new URL('../../packages/api/scripts/public-test-external-resource-guard.mjs', import.meta.url),
);
const requiresRootLinux = process.platform !== 'linux' || process.getuid() !== 0;
// Match the actual checkout owner on hosted runners; a made-up uid cannot
// traverse runner-private parent directories after setpriv.
const runnerUid = process.env.SUDO_UID ?? '1000';
const runnerGid = process.env.SUDO_GID ?? '1000';
const commandArgs = (command, launcherPath = launcher) => [
  launcherPath,
  runnerUid,
  runnerGid,
  process.env.PATH,
  ...command,
];
const nodeCommand = (code) => [process.execPath, '--import', resourceGuard, '-e', code];
const runCommand = (command, { isolated = true, launcherPath = launcher, input } = {}) =>
  spawnSync(
    isolated ? 'unshare' : launcherPath,
    isolated ? ['--net', '--', ...commandArgs(command, launcherPath)] : commandArgs(command, launcherPath).slice(1),
    {
      encoding: 'utf8',
      input,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        CAT_CAFE_PUBLIC_TEST_NETNS_PROOF: '/forged/path',
        CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable',
      },
    },
  );
const run = (code, options) => runCommand(nodeCommand(code), options);

const nondumpablePython = `
import ctypes, os, time
if os.getuid() == 0:
    os.setgroups([])
    os.setgid(${Number(runnerGid)})
    os.setuid(${Number(runnerUid)})
assert ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0
print('ready', flush=True)
time.sleep(60)
`;

async function withCommandAsInitAsync(check) {
  const root = mkdtempSync(join(tmpdir(), 'public-test-old-init-'));
  chmodSync(root, 0o755); // Dropped test UID must traverse this root-owned fixture.
  const oldLauncher = join(root, 'launcher.sh');
  const source = readFileSync(launcher, 'utf8');
  const marker = 'exec /usr/bin/python3 -I "$(dirname "$(readlink -f "$0")")/public-test-namespace-init.py" "$@"';
  assert.ok(source.includes(marker));
  writeFileSync(oldLauncher, source.replace(marker, 'exec "$@"'), { mode: 0o755 });
  try {
    return await check(oldLauncher);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function ready(child) {
  let timer;
  try {
    const [chunk] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture did not start')), 5000);
      }),
    ]);
    assert.equal(chunk.toString().trim(), 'ready');
  } finally {
    clearTimeout(timer);
  }
}

function processIdentity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], parent: Number(fields[1]), birth: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function stillOwned(owned) {
  if (!owned) return false;
  const current = processIdentity(owned.pid);
  return current && current.birth === owned.birth && current.state !== 'Z';
}

async function waitForOwnedExit(owned, message) {
  const deadline = Date.now() + 5000;
  while (stillOwned(owned)) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}

async function reclaimOwnedInit(owned) {
  if (!stillOwned(owned)) return;
  try {
    process.kill(owned.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await waitForOwnedExit(owned, 'failed to reclaim owned namespace init');
}

describe(
  'public-test launcher kernel receipt',
  { skip: requiresRootLinux && 'requires isolated Linux root to create a network namespace' },
  () => {
    it('emits a protected receipt for the exact child namespace before dropping all privileges', () => {
      const child = run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const receiptPath = process.env.CAT_CAFE_PUBLIC_TEST_NETNS_PROOF;
      assert.notEqual(receiptPath, '/forged/path');
      const directory = fs.lstatSync(path.dirname(receiptPath));
      const file = fs.lstatSync(receiptPath);
      assert.equal(directory.uid, 0);
      assert.equal(directory.mode & 0o777, 0o755);
      assert.equal(file.uid, 0);
      assert.equal(file.mode & 0o777, 0o444);
      assert.ok(file.isFile() && !file.isSymbolicLink());
      assert.throws(() => fs.openSync(receiptPath, 'w'), { code: 'EACCES' });
      assert.throws(() => fs.unlinkSync(receiptPath), { code: 'EACCES' });
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      const ns = fs.statSync('/proc/self/ns/net', { bigint: true });
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.isolated, ns.dev + ':' + ns.ino);
      assert.notEqual(receipt.host, receipt.isolated);
      assert.equal(receipt.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      assert.match(receipt.nonce, /^[a-f0-9-]{36}$/);
      assert.notEqual(process.getuid(), 0);
      process.stdout.write(JSON.stringify({ receipt: 'verified', nonce: receipt.nonce }));
    `);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(JSON.parse(child.stdout).receipt, 'verified');
    });

    it('refuses same-host launch rather than issuing proof for an empty route table', () => {
      const child = run('process.stdout.write("must-not-run")', { isolated: false });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /shares the host network namespace/);
      assert.doesNotMatch(child.stdout, /must-not-run/);
    });

    it('preserves the command exit status through the privilege boundary', () => {
      const child = run('process.exit(37)');
      assert.equal(child.status, 37, child.stdout + child.stderr);
      const signaled = run('process.kill(process.pid, "SIGTERM")');
      assert.equal(signaled.status, 143, signaled.stdout + signaled.stderr);
      const input = runCommand(nodeCommand('process.stdout.write(require("node:fs").readFileSync(0))'), {
        input: 'owned-stdin',
      });
      assert.equal(input.status, 0, input.stdout + input.stderr);
      assert.equal(input.stdout, 'owned-stdin');
    });

    it('requires SIGKILL parent-death handling in the actual unprivileged namespace init', () => {
      const child = runCommand([
        '/usr/bin/python3',
        '-c',
        `
import os
assert os.getpid() > 1 and os.getppid() == 1
assert os.getuid() == ${Number(runnerUid)} and os.getuid() != 0
assert os.getgid() == ${Number(runnerGid)}
print('supervised-command')
`,
      ]);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(child.stdout.trim(), 'supervised-command');
      // Execute the real init with a deliberately absent PDEATHSIG. It must
      // reject before launching any command, even with otherwise valid PID/UID.
      const rejected = spawnSync(
        'unshare',
        [
          '--pid',
          '--fork',
          '--mount-proc',
          '--',
          'setpriv',
          '--reuid',
          runnerUid,
          '--regid',
          runnerGid,
          '--clear-groups',
          '/usr/bin/python3',
          '-I',
          namespaceInit,
          process.execPath,
          '-e',
          'console.log("must-not-run")',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /namespace init failed/);
      assert.doesNotMatch(rejected.stdout, /must-not-run/);
    });

    it('refuses the process-domain stage without a fresh namespace and matching procfs', () => {
      const ns = statSync('/proc/self/ns/pid', { bigint: true });
      const child = spawnSync(
        launcher,
        [
          '--verify-process-domain',
          `${ns.dev}:${ns.ino}`,
          runnerUid,
          runnerGid,
          process.env.PATH,
          process.execPath,
          '-e',
          'process.stdout.write("must-not-run")',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /procfs is not bound to a fresh process namespace/);
      assert.doesNotMatch(child.stdout, /must-not-run/);
    });

    it('isolates cleanup from a live same-UID non-dumpable host process', async () => {
      const host = spawn('/usr/bin/python3', ['-c', nondumpablePython], { stdio: ['ignore', 'pipe', 'inherit'] });
      const hostExited = once(host, 'exit');
      try {
        await ready(host);
        const denied = spawnSync(
          'setpriv',
          [
            '--reuid',
            runnerUid,
            '--regid',
            runnerGid,
            '--clear-groups',
            process.execPath,
            '-e',
            `
            require('node:assert/strict').throws(() => require('node:fs').readFileSync('/proc/${host.pid}/environ'), { code: 'EACCES' });
          `,
          ],
          { encoding: 'utf8', timeout: 5000 },
        );
        assert.equal(denied.status, 0, denied.stdout + denied.stderr);
        const parent = statSync('/proc/self/ns/pid', { bigint: true });
        const child = run(`
          (async () => {
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const self = fs.statSync('/proc/self/ns/pid', { bigint: true });
            const init = fs.statSync('/proc/1/ns/pid', { bigint: true });
            assert.ok(process.pid > 1);
            assert.equal(process.ppid, 1);
            assert.equal(self.ino, init.ino);
            assert.notEqual(self.dev + ':' + self.ino, ${JSON.stringify(`${parent.dev}:${parent.ino}`)});
            const { detectKernelNetworkBoundary } = await import(${JSON.stringify(namespaceProbe)});
            assert.equal(detectKernelNetworkBoundary(), 'verified');
            const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
            process.exitCode = await runTestCommand([process.execPath, '-e', ''], {
              cwd: process.cwd(), env: {}, signal: new AbortController().signal,
            });
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `);
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.equal(host.exitCode, null);
        process.kill(host.pid, 0); // Isolation did not signal the host fixture.
      } finally {
        host.kill('SIGKILL');
        await hostExited;
      }
    });

    it('still rejects an unreadable same-domain process instead of granting cleanup proof', () => {
      const child = run(`
        (async () => {
          const { spawn } = require('node:child_process');
          const { once } = require('node:events');
          const denied = spawn('/usr/bin/python3', ['-c', ${JSON.stringify(nondumpablePython)}], { stdio: ['ignore', 'pipe', 'inherit'] });
          const exited = once(denied, 'exit');
          try {
            await once(denied.stdout, 'data');
            const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
            process.exitCode = await runTestCommand([process.execPath, '-e', ''], {
              cwd: process.cwd(), env: {}, signal: new AbortController().signal,
            });
          } finally { denied.kill('SIGKILL'); await exited; }
        })().catch(error => { console.error(error); process.exitCode = 2; });
      `);
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /cleanup=unknown killed=0/);
      assert.match(child.stderr, /"operation":"proc-environ","code":"EACCES"/);
    });

    for (const workerSurvives of [false, true]) {
      it(`checks actual terminal thread-group evidence (live worker=${workerSurvives})`, () => {
        const proofModule = new URL('../../scripts/lib/gate-linux-process-exit.mjs', import.meta.url).href;
        const python = workerSurvives
          ? "import ctypes, threading, time; threading.Thread(target=lambda: time.sleep(60)).start(); print('ready', flush=True); ctypes.CDLL(None).pthread_exit(None)"
          : 'import os,time; pid=os.fork(); os._exit(0) if pid == 0 else None; print(pid, flush=True); time.sleep(60)';
        const child = run(`
          (async () => {
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const {spawn} = require('node:child_process');
            const {once} = require('node:events');
            const {setTimeout:delay} = require('node:timers/promises');
            const {readLinuxExitIdentity, proveLinuxExecutionExited} = await import(${JSON.stringify(proofModule)});
            const owned = spawn('/usr/bin/python3', ['-c', ${JSON.stringify(python)}], {stdio:['ignore','pipe','inherit']});
            const exited = once(owned,'exit');
            try {
              const [ready] = await once(owned.stdout,'data');
              const pid = ${workerSurvives} ? owned.pid : Number(ready.toString().trim());
              const deadline = Date.now()+3000;
              let identity;
              do {
                identity = readLinuxExitIdentity(pid,fs.readFileSync);
                if (identity?.state === 'Z') break;
                assert.ok(Date.now()<deadline, 'fixture leader did not reach terminal state');
                await delay(10);
              } while(true);
              const proof = proveLinuxExecutionExited(pid,identity,{readFileSyncImpl:fs.readFileSync,readdirSyncImpl:fs.readdirSync});
              console.log('terminal proof='+JSON.stringify(proof));
              assert.equal(proof.proven, ${!workerSurvives});
            } finally { owned.kill('SIGKILL'); await exited; }
          })().catch(error => {console.error(error);process.exitCode=2;});
        `);
        assert.equal(child.status, 0, child.stdout + child.stderr);
      });
    }

    it('acquires and fences a Native profile lease with the actual namespace process identity', () => {
      const ownership = new URL('../../packages/api/src/utils/cli-process-ownership.ts', import.meta.url).href;
      const lease = new URL(
        '../../packages/api/src/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.ts',
        import.meta.url,
      ).href;
      const tsxLoader = createRequire(new URL('../../packages/api/package.json', import.meta.url)).resolve('tsx');
      const child = runCommand([
        process.execPath,
        '--import',
        resourceGuard,
        '--import',
        tsxLoader,
        '-e',
        `
        (async () => {
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const os = require('node:os');
          const path = require('node:path');
          const { readUnixProcessSnapshotSync, readUnixProcessSnapshot } = await import(${JSON.stringify(ownership)});
          const { acquireAgyNativeProfileTurn, AgyNativeProfileBusyError } = await import(${JSON.stringify(lease)});
          const identity = readUnixProcessSnapshotSync({pids:[process.pid]})?.get(process.pid);
          console.log('namespace identity=' + JSON.stringify(identity));
          assert.ok(identity?.startedAt);
          assert.equal(identity.pid, process.pid);
          assert.deepEqual((await readUnixProcessSnapshot({pids:[process.pid]})).get(process.pid), identity);
          const home = fs.mkdtempSync(path.join(os.tmpdir(),'native-lease-namespace-'));
          process.env.CAT_CAFE_DATA_DIR = home;
          try {
            const release = acquireAgyNativeProfileTurn(home, 'namespace-owned-turn');
            try { assert.throws(() => acquireAgyNativeProfileTurn(home, 'other-turn'), AgyNativeProfileBusyError); }
            finally { release(); }
            acquireAgyNativeProfileTurn(home, 'successor-turn')();
          } finally { fs.rmSync(home, {recursive:true,force:true}); }
        })().catch(error => { console.error(error); process.exitCode = 2; });
      `,
      ]);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /namespace identity=/);
    });

    it('detects and cleans a token-owned detached descendant while failing the leaking command', () => {
      const child = run(`
        (async () => {
          const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
          process.exitCode = await runTestCommand([process.execPath, '-e',
            "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref()"
          ], { cwd: process.cwd(), env: {}, signal: new AbortController().signal });
        })().catch(error => { console.error(error); process.exitCode = 2; });
      `);
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /cleanup=proven killed=1/);
    });

    it('observes the old unreaped orphan and reaps the same fixture with a dedicated init', async () => {
      const proofModule = new URL('../../scripts/lib/gate-linux-process-exit.mjs', import.meta.url).href;
      const owner = `
import os, signal, time
r, w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(r)
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(w, b'r')
    os.close(w)
    time.sleep(60)
    os._exit(0)
os.close(w)
os.read(r, 1)
print(pid, flush=True)
os._exit(0)
`;
      const probe = `
        (async () => {
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const {spawn} = require('node:child_process');
          const {once} = require('node:events');
          const {setTimeout:delay} = require('node:timers/promises');
          const {readLinuxExitIdentity, proveLinuxExecutionExited} = await import(${JSON.stringify(proofModule)});
          const read = pid => {
            try {
              const raw = fs.readFileSync('/proc/'+pid+'/stat','utf8');
              const f = raw.slice(raw.lastIndexOf(')')+2).trim().split(/\\s+/);
              return {pid,state:f[0],parent:Number(f[1]),group:Number(f[2]),threads:Number(f[17]),birth:f[19]};
            } catch(error) { if(error.code === 'ENOENT') return null; throw error; }
          };
          const parent = spawn('/usr/bin/python3',['-c',${JSON.stringify(owner)}],{stdio:['ignore','pipe','inherit']});
          const exited = once(parent,'exit');
          let original;
          try {
            const [data] = await once(parent.stdout,'data');
            const pid = Number(data.toString().trim());
            await exited;
            original = read(pid);
            assert.ok(original && pid > 1 && original.parent === 1 && original.group === pid);
            console.log('adopted='+JSON.stringify(original));
            process.kill(pid,'SIGTERM');
            await delay(50);
            const live = read(pid);
            assert.equal(live?.birth, original.birth);
            assert.ok(!['Z','X','x'].includes(live.state), 'TERM-ignoring orphan must remain live');
            const before = readLinuxExitIdentity(pid,fs.readFileSync);
            process.kill(pid,'SIGKILL');
            const deadline = Date.now()+2000;
            let current;
            while ((current = read(pid)) && Date.now()<deadline) {
              assert.equal(current.birth, original.birth, 'identity reuse is not proof');
              await delay(10);
            }
            if (current) {
              const proof = proveLinuxExecutionExited(pid,before,{readFileSyncImpl:fs.readFileSync,readdirSyncImpl:fs.readdirSync});
              console.log('unreaped='+JSON.stringify({current,proof}));
              assert.equal(proof.proven, true, 'counterexample needs whole-execution exit proof');
              process.exitCode=42;
            } else {
              assert.throws(()=>process.kill(pid,0), {code:'ESRCH'});
              console.log('orphan-reaped');
            }
          } finally {
            parent.kill('SIGKILL');
            await exited;
            const current = original && read(original.pid);
            if(current?.birth === original?.birth && current) process.kill(current.pid,'SIGKILL');
          }
        })().catch(error=>{console.error(error);process.exitCode=2;});
      `;
      await withCommandAsInitAsync((legacyLauncher) => {
        const before = run(probe, { launcherPath: legacyLauncher });
        assert.equal(before.status, 42, before.stdout + before.stderr);
        assert.match(before.stdout, /unreaped=.*"parent":1.*"proven":true/);
      });
      const after = run(probe);
      assert.equal(after.status, 0, after.stdout + after.stderr);
      assert.match(after.stdout, /orphan-reaped/);
      assert.doesNotMatch(after.stdout, /unreaped=/);
    });

    const checkMonitorDeath = async (command, launcherPath = launcher) => {
      const monitor = spawn('unshare', ['--net', '--', ...commandArgs(command, launcherPath)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exited = once(monitor, 'exit');
      let ownedInit;
      try {
        await ready(monitor);
        const children = spawnSync('ps', ['--ppid', String(monitor.pid), '-o', 'pid='], {
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(children.status, 0, children.stderr);
        const pids = children.stdout.trim().split(/\s+/).map(Number);
        assert.equal(pids.length, 1, 'unshare must own one namespace init');
        const pid = pids[0];
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        const original = processIdentity(pid);
        assert.ok(original?.birth);
        assert.equal(original.parent, monitor.pid, 'init must belong to this test monitor');
        ownedInit = { pid, birth: original.birth };
        monitor.kill('SIGKILL');
        await exited;
        await waitForOwnedExit(ownedInit, 'namespace init survived its monitor');
      } finally {
        if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill('SIGKILL');
        await exited;
        // A failed teardown assertion must not leave the fixture/domain alive.
        // Recheck birth identity before signalling only our captured init.
        try {
          await reclaimOwnedInit(ownedInit);
        } finally {
          monitor.stdout.destroy();
        }
      }
    };

    it('tears down namespace init when its owned root monitor is killed', async () => {
      await checkMonitorDeath(nodeCommand("console.log('ready'); setInterval(() => {}, 1000)"));
    });

    it('reclaims its owned init even when the monitor-death assertion fails', async () => {
      // Model the rejected launcher: deliberately clear the signal in PID 1.
      // The original assertion must fail, and finally must reclaim this domain.
      await assert.rejects(
        withCommandAsInitAsync((legacyLauncher) =>
          checkMonitorDeath(
            [
              '/usr/bin/python3',
              '-c',
              `
import ctypes, os, time
assert os.getpid() == 1
assert ctypes.CDLL(None, use_errno=True).prctl(1, 0, 0, 0, 0) == 0
print('ready', flush=True)
time.sleep(60)
`,
            ],
            legacyLauncher,
          ),
        ),
        /namespace init survived its monitor/,
      );
    });
  },
);
