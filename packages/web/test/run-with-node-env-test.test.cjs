const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const webRoot = resolve(__dirname, '..');
const runnerPath = resolve(webRoot, 'scripts', 'run-with-node-env-test.mjs');
const browserLeasePath = resolve(webRoot, 'scripts', 'browser-test-resource-lease.mjs');
const leaseLibraryPaths = [
  'process-resource-lease.mjs',
  'process-resource-lease-lock.mjs',
  'process-resource-lease-queue.mjs',
];

function createCompatibilityRunner(lockDir) {
  const publishedRoot = mkdtempSync(join(dirname(lockDir), 'published-'));
  const scriptsDir = join(publishedRoot, 'packages', 'web', 'scripts');
  const libraryDir = join(publishedRoot, 'scripts', 'lib');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });
  const copiedRunnerPath = join(scriptsDir, 'run-with-node-env-test.mjs');
  copyFileSync(runnerPath, copiedRunnerPath);
  copyFileSync(browserLeasePath, join(scriptsDir, 'browser-test-resource-lease.mjs'));
  for (const name of leaseLibraryPaths) {
    copyFileSync(resolve(webRoot, '..', '..', 'scripts', 'lib', name), join(libraryDir, name));
  }
  return copiedRunnerPath;
}

function createBrowserLeaseProbeSpawner(lockDir) {
  const compatibilityRunnerPath = createCompatibilityRunner(lockDir);
  return (options) => spawnBrowserLeaseProbe({ ...options, lockDir, compatibilityRunnerPath });
}

async function waitForLog(file, pattern, timeoutMs = 5_000) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      if (pattern.test(readFileSync(file, 'utf8'))) return;
    } catch {
      // The child has not created the log yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${file}`);
}

function spawnBrowserLeaseProbe({
  label,
  delayMs,
  logFile,
  lockDir,
  compatibilityRunnerPath,
  outerPermitHeld = true,
  env = {},
}) {
  const script = [
    "const { appendFileSync } = require('node:fs')",
    'const [logFile, label, delayMs] = process.argv.slice(1, 4)',
    "appendFileSync(logFile, label + ':start\\n')",
    "setTimeout(() => { appendFileSync(logFile, label + ':end\\n') }, Number(delayMs))",
  ].join(';');
  const child = spawn(
    process.execPath,
    [
      compatibilityRunnerPath,
      process.execPath,
      '-e',
      script,
      logFile,
      label,
      String(delayMs),
      'test/browser/lease-probe.mjs',
    ],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        CAT_CAFE_BROWSER_TEST_LOCK_DIR: lockDir,
        CAT_CAFE_BROWSER_TEST_LEASE_POLL_MS: '10',
        ...(outerPermitHeld
          ? {
              CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD: '1',
              CAT_CAFE_FULL_GATE_RESOURCE_MODE: 'exclusive',
              CAT_CAFE_FULL_GATE_RESOURCE_STAGE: 'test-web-browser',
            }
          : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise((resolveChild, rejectChild) => {
    child.on('error', rejectChild);
    child.on('exit', (code, signal) => resolveChild({ code, signal, output }));
  });
}

test('run-with-node-env-test forces NODE_ENV=test for vitest-invoked workspace tree actions', () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, 'pnpm', 'exec', 'vitest', 'run', 'src/components/workspace/__tests__/WorkspaceTree-actions.test.ts'],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /4 passed/);
});

test('run-with-node-env-test forces NODE_ENV=test for node commands', () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, process.execPath, '-e', "if (process.env.NODE_ENV !== 'test') process.exit(11)"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('test runner does not synthesize an F307-only activation environment', () => {
  const child = spawnSync(
    process.execPath,
    [
      runnerPath,
      process.execPath,
      '-e',
      [
        "if (process.env.NODE_ENV !== 'test') process.exit(11)",
        "if (process.env.CAT_CAFE_DEPLOYMENT_ID !== 'test') process.exit(12)",
        'if (process.env.CAT_CAFE_F307_WORKBENCH_GATE_ACTIVATION !== undefined) process.exit(13)',
      ].join(';'),
    ],
    { cwd: webRoot, encoding: 'utf8' },
  );

  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('published compatibility copies retain one cross-worktree browser lease', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-browser-test-lease-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(logFile, '');
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const first = spawnProbe({ label: 'first', delayMs: 400, logFile });
    await waitForLog(logFile, /first:start/);
    const second = spawnProbe({ label: 'second', delayMs: 20, logFile });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.code, 0, firstResult.output);
    assert.equal(secondResult.code, 0, secondResult.output);
    assert.doesNotMatch(firstResult.output, /standalone-web-browser/);
    assert.doesNotMatch(secondResult.output, /standalone-web-browser/);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser test commands recover a lease whose exact holder is no longer alive', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stale-browser-test-lease-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(logFile, '');
    writeFileSync(
      lockDir,
      `${JSON.stringify({
        leaseId: 'stale-lease',
        holderPid: 99_999_999,
        cwd: '/stale/worktree',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
    );
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const result = await spawnProbe({ label: 'recovered', delayMs: 20, logFile });

    assert.equal(result.code, 0, result.output);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['recovered:start', 'recovered:end']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser test commands recover corrupt lease metadata instead of waiting for the full bound', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-corrupt-browser-test-lease-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(logFile, '');
    writeFileSync(lockDir, '{not-json\n');
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const result = await spawnProbe({
      label: 'recovered',
      delayMs: 20,
      logFile,
      env: { CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '200' },
    });

    assert.equal(result.code, 0, result.output);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['recovered:start', 'recovered:end']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser test commands do not remain blocked by the legacy orphaned recovery guard', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-orphaned-browser-test-recovery-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(logFile, '');
    mkdirSync(`${lockDir}.recovering`);
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const result = await spawnProbe({
      label: 'recovered',
      delayMs: 20,
      logFile,
      env: { CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '200' },
    });

    assert.equal(result.code, 0, result.output);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['recovered:start', 'recovered:end']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('browser test commands reclaim a dead recovery sentinel and its claimed lease artifact', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-dead-browser-test-recovery-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');
  const sentinelPath = `${lockDir}.recovering.99999999.orphaned-recovery`;
  const claimedPath = `${sentinelPath}.claimed`;

  try {
    appendFileSync(logFile, '');
    writeFileSync(sentinelPath, '{truncated');
    writeFileSync(claimedPath, 'stale claimed lease');
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const result = await spawnProbe({ label: 'recovered', delayMs: 20, logFile });

    assert.equal(result.code, 0, result.output);
    assert.equal(existsSync(sentinelPath), false);
    assert.equal(existsSync(claimedPath), false);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['recovered:start', 'recovered:end']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('stale lease recovery stays single-holder under many simultaneous waiters', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-stale-browser-test-race-'));

  try {
    for (let round = 0; round < 8; round += 1) {
      const roundDir = join(tempRoot, `round-${round}`);
      const logFile = join(roundDir, 'events.log');
      const lockDir = join(roundDir, 'browser.lock');
      mkdirSync(roundDir);
      appendFileSync(logFile, '');
      writeFileSync(
        lockDir,
        `${JSON.stringify({
          leaseId: `stale-lease-${round}`,
          holderPid: 99_999_999,
          cwd: '/stale/worktree',
          startedAt: '2026-08-29T00:00:00.000Z',
        })}\n`,
      );
      const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);

      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          spawnProbe({
            label: `w${index}`,
            delayMs: 20,
            logFile,
          }),
        ),
      );
      for (const result of results) assert.equal(result.code, 0, result.output);

      let holders = 0;
      let peakHolders = 0;
      for (const event of readFileSync(logFile, 'utf8').trim().split('\n')) {
        if (event.endsWith(':start')) holders += 1;
        if (event.endsWith(':end')) holders -= 1;
        peakHolders = Math.max(peakHolders, holders);
      }
      assert.equal(peakHolders, 1, `round ${round} observed ${peakHolders} simultaneous holders`);
      assert.equal(holders, 0);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a live non-progressing holder produces periodic identity-rich wait diagnostics', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-live-browser-test-lease-'));
  const logFile = join(tempDir, 'events.log');
  const lockDir = join(tempDir, 'browser.lock');

  try {
    appendFileSync(logFile, '');
    const spawnProbe = createBrowserLeaseProbeSpawner(lockDir);
    const holder = spawnProbe({ label: 'holder', delayMs: 400, logFile });
    await waitForLog(logFile, /holder:start/);
    const waiter = await spawnProbe({
      label: 'waiter',
      delayMs: 10,
      logFile,
      env: {
        CAT_CAFE_BROWSER_TEST_LEASE_LOG_MS: '25',
        CAT_CAFE_BROWSER_TEST_LEASE_WAIT_MS: '120',
      },
    });
    const holderResult = await holder;

    assert.equal(holderResult.code, 0, holderResult.output);
    assert.equal(waiter.code, 1, waiter.output);
    const diagnostics = waiter.output.match(/\[browser-test-lease\] waiting .*elapsedMs=\d+/g) ?? [];
    assert.ok(diagnostics.length >= 3, waiter.output);
    assert.match(waiter.output, /holderPid=\d+/);
    assert.match(waiter.output, /holderCwd=/);
    assert.match(waiter.output, /holderStartedAt=/);
    assert.match(waiter.output, /Timed out waiting 120ms .*holderPid=\d+.*holderCwd=.*holderStartedAt=/);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), ['holder:start', 'holder:end']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
