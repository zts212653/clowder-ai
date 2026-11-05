const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const runner = path.join(__dirname, 'scripts/profile-desktop-startup-runner.cjs');

// Test-only fault and phase markers; all production startup code remains real.
function preload({ optionsPath, events, release, window, cause }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const originalRead = fs.readFileSync;
  const record = (event) => fs.appendFileSync(events, `${JSON.stringify(event)}\n`);
  if (!process.argv[1]) {
    const on = process.stdin.on;
    process.stdin.on = function holdProbeEnd(event, callback) {
      if (event !== 'end' || window !== 'consumer') return on.call(this, event, callback);
      return on.call(this, event, (...args) => {
        process.stderr.write('FIXTURE_MIRROR_PROBE_ACTIVE\n');
        const tick = setInterval(() => {
          if (!fs.existsSync(release)) return;
          clearInterval(tick);
          callback(...args);
        }, 10);
      });
    };
    return;
  }
  if (process.argv[2] !== optionsPath) return;
  const options = JSON.parse(originalRead(optionsPath, 'utf8'));
  let deadline;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    record({ type: 'cancel', cause, window });
    if (cause === 'deadline') deadline();
    else process.emit('SIGTERM'); // Exercise the same registered handler on Windows and POSIX.
    fs.writeFileSync(release, 'release owned probe');
  };
  const setTimer = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => {
    if (ms !== options.timeoutMs) return setTimer(callback, ms, ...args);
    deadline = callback;
    // Deliver the production deadline callback at an observed phase, not at a
    // wall-clock guess about CI fork speed. The runner still owns this handle.
    return setTimer(() => {}, ms);
  };
  const docs = path.join(
    options.profileRoot,
    'instance/project/docs/harness-feedback/eval-domains/eval-design-gate.yaml',
  );
  fs.readFileSync = function failParentDocs(file, ...args) {
    if (file !== docs) return originalRead.call(this, file, ...args);
    if (window === 'backoff' && !cancelled) queueMicrotask(cancel);
    throw Object.assign(new Error('UNKNOWN: controlled parent docs failure'), { code: 'UNKNOWN', syscall: 'open' });
  };
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function observeOwnedChildren(command, args, settings) {
    const child = originalSpawn(command, args, settings);
    const probe = args[0] === '-e';
    record({ type: probe ? 'probe-spawn' : 'api-spawn', pid: child.pid });
    child.once('close', (code, signal) => record({ type: 'child-close', pid: child.pid, code, signal }));
    if (probe && window === 'consumer') {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.includes('FIXTURE_MIRROR_PROBE_ACTIVE')) cancel();
      });
    }
    return child;
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return [3003, 3004, 6399].includes(port) ? freePort() : port;
}

function readEvents(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

for (const window of ['backoff', 'consumer']) {
  for (const cause of ['deadline', 'SIGTERM']) {
    test(
      `profile ${cause} during mirror ${window} prevents API spawn and closes owned probes`,
      { timeout: 20000 },
      async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-mirror-cancel-'));
        const profileRoot = path.join(root, 'trace');
        const frozenRoot = path.join(root, 'frozen');
        const entry = path.join(frozenRoot, 'api/dist/index.desktop.js');
        const optionsPath = path.join(root, 'options.json');
        const events = path.join(root, 'events.ndjson');
        let child;
        let closed;
        let output = '';
        try {
          const { createProfileSource } = await import('./test-helpers/profile-source-fixture.mjs');
          const sourceRoot = await createProfileSource(root);
          fs.mkdirSync(profileRoot);
          fs.mkdirSync(path.dirname(entry), { recursive: true });
          fs.mkdirSync(path.join(frozenRoot, 'dependencies'));
          fs.writeFileSync(path.join(frozenRoot, 'api/package.json'), '{"type":"module"}');
          fs.writeFileSync(
            entry,
            'import {createServer} from "node:http"; createServer((q,r)=>r.end("ok")).listen(Number(process.env.API_SERVER_PORT),"127.0.0.1",()=>globalThis.__clowderStartupMilestone("http-listening"));',
          );
          const ports = new Set();
          while (ports.size < 3) ports.add(await freePort());
          const [frontendPort, apiPort, redisPort] = ports;
          fs.writeFileSync(
            optionsPath,
            JSON.stringify({ sourceRoot, frozenRoot, profileRoot, frontendPort, apiPort, redisPort, timeoutMs: 7777 }),
          );
          const requireFile = path.join(root, 'preload.cjs');
          fs.writeFileSync(
            requireFile,
            `(${preload.toString()})(${JSON.stringify({ optionsPath, events, release: path.join(root, 'release'), window, cause })});`,
          );
          child = spawn(process.execPath, [runner, optionsPath], {
            env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(requireFile)}` },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            output += chunk;
          });
          closed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => resolve(code));
          });
          const code = await closed;
          const observed = readEvents(events);
          assert.ok(
            observed.some((event) => event.type === 'cancel'),
            `The intended cancellation phase was not reached:\n${output}`,
          );
          assert.notEqual(code, 0, 'cancellation must fail the build profile');
          const probes = observed.filter((event) => event.type === 'probe-spawn');
          if (window === 'consumer')
            assert.ok(probes.length, 'a real independent Node must have reached its read phase');
          else assert.equal(probes.length, 0, 'backoff cancellation must prevent starting a new probe');
          for (const probe of probes) {
            assert.ok(
              observed.some((event) => event.type === 'child-close' && event.pid === probe.pid),
              'probe close must precede runner exit',
            );
            assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' });
          }
          assert.equal(
            observed.some((event) => event.type === 'api-spawn'),
            false,
            `API spawned after cancellation:\n${output}`,
          );
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await closed;
          }
          const observed = readEvents(events);
          const reaped = new Set(observed.filter((event) => event.type === 'child-close').map((event) => event.pid));
          const outstanding = observed.filter(
            (event) => ['probe-spawn', 'api-spawn'].includes(event.type) && !reaped.has(event.pid),
          );
          // A historic PID alone is not authority to kill a surviving process.
          if (outstanding.length) console.error('Retaining failed profile evidence:', root, outstanding);
          else fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}
