const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const webRoot = resolve(__dirname, '..');
const runnerPath = resolve(webRoot, 'scripts', 'run-with-node-env-test.mjs');
const gateResourceRunnerPath = resolve(webRoot, '..', '..', 'scripts', 'run-with-gate-resource-permit.mjs');
const homeResourcePoolTest = { skip: !existsSync(gateResourceRunnerPath) };
const RESOURCE_PERMIT_ENV_KEYS = [
  'CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD',
  'CAT_CAFE_FULL_GATE_RESOURCE_MODE',
  'CAT_CAFE_FULL_GATE_RESOURCE_STAGE',
];

async function waitFor(readValue, pattern, timeoutMs = 5_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      if (pattern.test(readValue())) return;
    } catch {
      // The child has not created its output yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${readValue()}`);
}

function matchCount(value, pattern) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function startProcess(args, { cwd = webRoot, env = {}, parentEnv = process.env } = {}) {
  const childEnv = { ...parentEnv };
  for (const key of RESOURCE_PERMIT_ENV_KEYS) {
    if (!Object.hasOwn(env, key)) delete childEnv[key];
  }
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const result = new Promise((resolveChild, rejectChild) => {
    child.on('error', rejectChild);
    child.on('exit', (code, signal) => resolveChild({ code, signal, output }));
  });
  return { child, output: () => output, result };
}

function resourceEnv(tempDir) {
  const fullGateLockPath = join(tempDir, 'full-gate.lock');
  const pressureFile = join(tempDir, 'normal-pressure.json');
  writeFileSync(pressureFile, JSON.stringify({ pressure: 'normal' }));
  return {
    CAT_CAFE_FULL_GATE_LOCK_PATH: fullGateLockPath,
    CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: `${fullGateLockPath}.resources.sqlite`,
    CAT_CAFE_FULL_GATE_RESOURCE_POLL_MS: '10',
    CAT_CAFE_FULL_GATE_RESOURCE_STALL_MS: '150',
    CAT_CAFE_FULL_GATE_RESOURCE_WAIT_MS: '1500',
    CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE: pressureFile,
  };
}

function startBrowserProbe({ delayMs, env = {}, label, lockDir, logFile, outerPermitHeld = false, parentEnv }) {
  const script = [
    "const { appendFileSync } = require('node:fs')",
    'const [logFile, label, delayMs] = process.argv.slice(1, 4)',
    "appendFileSync(logFile, label + ':start\\n')",
    "setTimeout(() => appendFileSync(logFile, label + ':end\\n'), Number(delayMs))",
  ].join(';');
  const permitEnv = outerPermitHeld
    ? {
        CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD: '1',
        CAT_CAFE_FULL_GATE_RESOURCE_MODE: 'exclusive',
        CAT_CAFE_FULL_GATE_RESOURCE_STAGE: 'test-web-browser',
      }
    : {};
  return startProcess(
    [runnerPath, process.execPath, '-e', script, logFile, label, String(delayMs), 'test/browser/probe.mjs'],
    {
      env: {
        CAT_CAFE_BROWSER_TEST_LOCK_DIR: lockDir,
        CAT_CAFE_BROWSER_TEST_LEASE_POLL_MS: '10',
        ...permitEnv,
        ...env,
      },
      parentEnv,
    },
  );
}

function startPoolBlocker({ delayMs, env, logFile }) {
  const script = [
    "const { appendFileSync } = require('node:fs')",
    'const [logFile, delayMs] = process.argv.slice(1, 3)',
    "appendFileSync(logFile, 'blocker:start\\n')",
    "setTimeout(() => appendFileSync(logFile, 'blocker:end\\n'), Number(delayMs))",
  ].join(';');
  return startProcess(
    [
      gateResourceRunnerPath,
      '--mode',
      'shared',
      '--stage',
      'browser-order-blocker',
      '--',
      process.execPath,
      '-e',
      script,
      logFile,
      String(delayMs),
    ],
    { env },
  );
}

test(
  'standalone browser tests enter the outer exclusive resource pool exactly once',
  homeResourcePoolTest,
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-standalone-browser-admission-'));
    const logFile = join(tempDir, 'events.log');
    const lockDir = join(tempDir, 'browser.lock');

    try {
      appendFileSync(logFile, '');
      const probe = startBrowserProbe({
        delayMs: 20,
        env: resourceEnv(tempDir),
        label: 'standalone',
        lockDir,
        logFile,
      });
      const result = await probe.result;

      assert.equal(result.code, 0, result.output);
      assert.equal(matchCount(result.output, /queued stage=standalone-web-browser/g), 1, result.output);
      assert.equal(matchCount(result.output, /acquired stage=standalone-web-browser/g), 1, result.output);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['standalone:start', 'standalone:end']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'concurrent Chromium commands serialize through the canonical pool without the legacy lock',
  homeResourcePoolTest,
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-canonical-concurrency-'));
    const logFile = join(tempDir, 'events.log');
    const env = resourceEnv(tempDir);

    try {
      appendFileSync(logFile, '');
      const first = startBrowserProbe({
        delayMs: 180,
        env,
        label: 'first',
        lockDir: join(tempDir, 'legacy-a.lock'),
        logFile,
      });
      await waitFor(() => readFileSync(logFile, 'utf8'), /first:start/);
      const second = startBrowserProbe({
        delayMs: 20,
        env,
        label: 'second',
        lockDir: join(tempDir, 'legacy-b.lock'),
        logFile,
      });
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

      assert.equal(firstResult.code, 0, firstResult.output);
      assert.equal(secondResult.code, 0, secondResult.output);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'home-repo browser admission no longer waits on the retired compatibility lock',
  homeResourcePoolTest,
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-retired-lock-'));
    const logFile = join(tempDir, 'events.log');
    const lockDir = join(tempDir, 'browser.lock');
    const { acquireBrowserTestResourceLease } = await import('../scripts/browser-test-resource-lease.mjs');
    const legacyHolder = await acquireBrowserTestResourceLease({
      cwd: webRoot,
      env: {
        CAT_CAFE_BROWSER_TEST_LOCK_DIR: lockDir,
        CAT_CAFE_BROWSER_TEST_LEASE_POLL_MS: '10',
        CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '500',
      },
    });

    try {
      appendFileSync(logFile, '');
      const probe = startBrowserProbe({
        delayMs: 20,
        env: { ...resourceEnv(tempDir), CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '120' },
        label: 'canonical-only',
        lockDir,
        logFile,
      });
      const result = await probe.result;

      assert.equal(result.code, 0, result.output);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
        'canonical-only:start',
        'canonical-only:end',
      ]);
    } finally {
      await legacyHolder.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'standalone probes do not inherit a test-web-unit shared permit from the test runner',
  homeResourcePoolTest,
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-standalone-browser-parent-permit-'));
    const logFile = join(tempDir, 'events.log');

    try {
      appendFileSync(logFile, '');
      const parentEnv = {
        ...process.env,
        CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD: '1',
        CAT_CAFE_FULL_GATE_RESOURCE_MODE: 'shared',
        CAT_CAFE_FULL_GATE_RESOURCE_STAGE: 'test-web-unit',
      };
      const probe = startBrowserProbe({
        delayMs: 20,
        env: resourceEnv(tempDir),
        label: 'standalone',
        lockDir: join(tempDir, 'browser.lock'),
        logFile,
        parentEnv,
      });
      const result = await probe.result;

      assert.equal(result.code, 0, result.output);
      assert.equal(matchCount(result.output, /acquired stage=standalone-web-browser/g), 1, result.output);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['standalone:start', 'standalone:end']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test('standalone admission acquires the outer pool before the legacy browser lock', homeResourcePoolTest, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-admission-order-'));
  const blockerLog = join(tempDir, 'blocker.log');
  const browserLog = join(tempDir, 'browser.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(blockerLog, '');
    appendFileSync(browserLog, '');
    const env = resourceEnv(tempDir);
    const blocker = startPoolBlocker({ delayMs: 500, env, logFile: blockerLog });
    await waitFor(() => readFileSync(blockerLog, 'utf8'), /blocker:start/);

    const standalone = startBrowserProbe({ delayMs: 20, env, label: 'standalone', lockDir, logFile: browserLog });
    await waitFor(standalone.output, /waiting stage=standalone-web-browser/);

    const legacyOnly = startBrowserProbe({
      delayMs: 20,
      env: { CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '200' },
      label: 'legacy-only',
      lockDir,
      logFile: browserLog,
      outerPermitHeld: true,
    });
    const [legacyResult, blockerResult, standaloneResult] = await Promise.all([
      legacyOnly.result,
      blocker.result,
      standalone.result,
    ]);

    assert.equal(legacyResult.code, 0, legacyResult.output);
    assert.equal(blockerResult.code, 0, blockerResult.output);
    assert.equal(standaloneResult.code, 0, standaloneResult.output);
    assert.deepEqual(readFileSync(browserLog, 'utf8').trim().split('\n'), [
      'legacy-only:start',
      'legacy-only:end',
      'standalone:start',
      'standalone:end',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser commands reject partial or non-exclusive outer permit markers', homeResourcePoolTest, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-admission-marker-'));
  const logFile = join(tempDir, 'events.log');

  try {
    appendFileSync(logFile, '');
    const probe = startBrowserProbe({
      delayMs: 20,
      env: {
        CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD: '1',
        CAT_CAFE_FULL_GATE_RESOURCE_MODE: 'shared',
        CAT_CAFE_FULL_GATE_RESOURCE_STAGE: 'build',
      },
      label: 'invalid-marker',
      lockDir: join(tempDir, 'browser.lock'),
      logFile,
    });
    const result = await probe.result;

    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /refusing a partial or mismatched marker/);
    assert.equal(readFileSync(logFile, 'utf8'), '');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  'standalone admission forwards termination and releases both coordination layers',
  homeResourcePoolTest,
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-admission-signal-'));
    const logFile = join(tempDir, 'events.log');
    const lockDir = join(tempDir, 'browser.lock');

    try {
      appendFileSync(logFile, '');
      const env = resourceEnv(tempDir);
      const signaled = startBrowserProbe({ delayMs: 5_000, env, label: 'signaled', lockDir, logFile });
      await waitFor(() => readFileSync(logFile, 'utf8'), /signaled:start/);
      signaled.child.kill('SIGTERM');
      const signaledResult = await Promise.race([
        signaled.result,
        new Promise((_, reject) => setTimeout(() => reject(new Error('browser wrapper did not exit')), 3_000)),
      ]);

      assert.equal(signaledResult.code, null, signaledResult.output);
      assert.equal(signaledResult.signal, 'SIGTERM', signaledResult.output);
      const after = startBrowserProbe({ delayMs: 20, env, label: 'after', lockDir, logFile });
      const afterResult = await after.result;
      assert.equal(afterResult.code, 0, afterResult.output);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
        'signaled:start',
        'after:start',
        'after:end',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
