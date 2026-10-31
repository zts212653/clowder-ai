import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateChild } from '../scripts/with-test-home.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withTestHome = resolve(__dirname, '../scripts/with-test-home.mjs');

function run(args) {
  return spawnSync(process.execPath, [withTestHome, ...args], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const isWindows = process.platform === 'win32';

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(
    `with-test-home waits for a delayed descendant before removing HOME on ${signal}`,
    { skip: isWindows, timeout: 20_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'delayed-descendant-'));
      const parentFile = join(root, 'parent.json');
      const readyFile = join(root, 'grandchild-ready');
      const resultFile = join(root, 'grandchild-result.json');
      const grandchild = `
        const { existsSync, writeFileSync } = require('node:fs');
        process.on('SIGTERM', () => {});
        process.on('SIGINT', () => {});
        writeFileSync(process.env.DELAYED_READY, 'ready');
        setTimeout(() => {
          writeFileSync(process.env.DELAYED_RESULT, JSON.stringify({
            homeExists: existsSync(process.env.HOME),
            home: process.env.HOME,
            at: Date.now(),
          }));
          process.exit(0);
        }, 1200);
        setInterval(() => {}, 1000);
      `;
      const parent = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
        writeFileSync(process.env.DELAYED_PARENT, JSON.stringify({ pid: child.pid, home: process.env.HOME }));
        setInterval(() => {}, 1000);
      `;

      const wrapper = spawn(process.execPath, [withTestHome, 'node', '-e', parent], {
        cwd: resolve(__dirname, '..'),
        env: {
          ...process.env,
          DELAYED_PARENT: parentFile,
          DELAYED_READY: readyFile,
          DELAYED_RESULT: resultFile,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      wrapper.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      try {
        await waitForFile(readyFile);
        const observed = JSON.parse(readFileSync(parentFile, 'utf8'));
        const started = Date.now();
        wrapper.kill(signal);
        await Promise.race([
          once(wrapper, 'close'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`wrapper did not exit after ${signal}: ${stderr}`)), 15_000),
          ),
        ]);
        const elapsed = Date.now() - started;
        await waitForFile(resultFile);
        const descendant = JSON.parse(readFileSync(resultFile, 'utf8'));
        assert.equal(descendant.homeExists, true, 'descendant must not observe a removed HOME');
        assert.equal(existsSync(observed.home), false, 'HOME must be removed after the descendant exits');
        assert.ok(elapsed >= 800, `wrapper exited before the delayed descendant (${elapsed}ms)`);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test('with-test-home isolates installer writes from inherited account roots and legacy HOME', () => {
  const outerRoot = mkdtempSync(join(tmpdir(), 'account-root-sentinel-'));
  const configDir = join(outerRoot, '.cat-cafe');
  const outerHome = join(outerRoot, 'home');
  mkdirSync(configDir);
  mkdirSync(join(outerHome, '.cat-cafe'), { recursive: true });
  const sentinels = {
    'accounts.json': JSON.stringify({ 'user-owned': { authType: 'api_key', displayName: 'Keep me' } }),
    'credentials.json': JSON.stringify({ 'user-owned': { apiKey: 'sentinel-only' } }),
    'cat-catalog.json': JSON.stringify({ accounts: {}, breeds: [{ accountRef: 'user-owned' }] }),
    'provider-profiles.json': JSON.stringify({
      version: 2,
      providers: [{ id: 'installer-managed', authType: 'api_key', displayName: 'Outer legacy' }],
    }),
    'provider-profiles.secrets.local.json': JSON.stringify({
      profiles: { 'installer-managed': { apiKey: 'legacy-sentinel' } },
    }),
  };
  try {
    for (const [name, content] of Object.entries(sentinels)) writeFileSync(join(configDir, name), content);
    for (const name of ['provider-profiles.json', 'provider-profiles.secrets.local.json']) {
      writeFileSync(join(outerHome, '.cat-cafe', name), sentinels[name]);
    }
    const installer = resolve(__dirname, '../../../scripts/install-auth-config.mjs');
    const probe = `
      const { spawnSync } = require('node:child_process');
      const { readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const result = spawnSync(process.execPath, [process.argv[1], 'client-auth', 'set',
        '--client', 'openai', '--mode', 'api_key', '--api-key', 'isolated-fixture'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      const accounts = JSON.parse(readFileSync(join(process.env.HOME, '.cat-cafe/accounts.json'), 'utf8'));
      const credentials = JSON.parse(readFileSync(join(process.env.HOME, '.cat-cafe/credentials.json'), 'utf8'));
      console.log(JSON.stringify({ ids: Object.keys(accounts), credentialIds: Object.keys(credentials) }));
    `;
    const result = spawnSync(process.execPath, [withTestHome, 'node', '-e', probe, installer], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, HOME: outerHome, CAT_CAFE_GLOBAL_CONFIG_ROOT: outerRoot },
      encoding: 'utf8',
    });
    for (const [name, content] of Object.entries(sentinels)) {
      assert.equal(readFileSync(join(configDir, name), 'utf8'), content, `outer ${name} must remain byte-identical`);
    }
    for (const name of ['provider-profiles.json', 'provider-profiles.secrets.local.json']) {
      assert.equal(readFileSync(join(outerHome, '.cat-cafe', name), 'utf8'), sentinels[name]);
    }
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ids: ['installer-openai'], credentialIds: ['installer-openai'] });
  } finally {
    rmSync(outerRoot, { recursive: true, force: true });
  }
});

test('with-test-home enables write guards despite inherited sandbox bypass flags', () => {
  const result = spawnSync(
    process.execPath,
    [
      withTestHome,
      'node',
      '-e',
      'console.log(JSON.stringify([process.env.CAT_CAFE_TEST_SANDBOX, process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT ?? null]))',
    ],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, CAT_CAFE_TEST_SANDBOX: '0', CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['1', null]);
});

test('with-test-home forces NODE_ENV=test even when outer shell is production', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', 'process.env.NODE_ENV'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'test');
});

test('with-test-home strips runtime default cat override from outer shell', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', 'process.env.DEFAULT_CAT_ID ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DEFAULT_CAT_ID: 'codex',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips runtime API host binding from outer shell', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', 'process.env.API_SERVER_HOST ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      API_SERVER_HOST: '0.0.0.0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Codex carrier from outer shell', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CODEX_CARRIER ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_CODEX_CARRIER: 'app_server',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Claude carrier from outer shell', () => {
  const result = spawnSync(
    process.execPath,
    [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CLAUDE_CARRIER ?? ""'],
    {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

for (const field of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
  test(`with-test-home strips inherited ${field} before account fixtures load`, () => {
    const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', `process.env.${field} ?? ""`], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, [field]: '/outer-owned-codex-fixture' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  });
}

test('with-test-home allows the child fixture to select its own Codex roots', () => {
  const probe = `
    process.env.CODEX_HOME = process.env.HOME + '/fixture-auth';
    process.env.CODEX_SQLITE_HOME = process.env.HOME + '/fixture-state';
    console.log(JSON.stringify({
      home: process.env.HOME,
      auth: process.env.CODEX_HOME,
      state: process.env.CODEX_SQLITE_HOME,
      marker: process.env.TEST_HOME_FIXTURE_MARKER,
    }));
  `;
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-e', probe], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_HOME: '/outer-auth-fixture',
      CODEX_SQLITE_HOME: '/outer-state-fixture',
      TEST_HOME_FIXTURE_MARKER: 'preserved',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.auth, `${observed.home}/fixture-auth`);
  assert.equal(observed.state, `${observed.home}/fixture-state`);
  assert.equal(observed.marker, 'preserved');
});

// REDIS_URL is the one binding here that must be pinned rather than stripped.
// `packages/shared/src/utils/redis.ts` resolves it with a fallback to the
// protected endpoint, so an absent value selects that endpoint instead of
// selecting nothing. These two cases are the boundary; without them it is
// asserted only by a comment.
const REDIS_URL_PROBE = 'process.env.REDIS_URL ?? ""';

test('with-test-home pins REDIS_URL when the outer shell has none', () => {
  const outer = { ...process.env };
  delete outer.REDIS_URL;
  delete outer.CAT_CAFE_REDIS_TEST_ISOLATED;

  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', REDIS_URL_PROBE], {
    cwd: resolve(__dirname, '..'),
    env: outer,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:0');
});

test('with-test-home overrides an inherited REDIS_URL instead of trusting it', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', REDIS_URL_PROBE], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_REDIS_TEST_ISOLATED: '',
      REDIS_URL: 'redis://127.0.0.1:6399',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:0');
});

test('with-test-home rejects an isolated flag without a runner lease before executing the command', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', REDIS_URL_PROBE], {
    env: {
      ...process.env,
      REDIS_URL: 'redis://127.0.0.1:6947/15',
      CAT_CAFE_REDIS_TEST_ISOLATED: '1',
      CAT_CAFE_REDIS_TEST_DB_MANIFEST: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing sandbox reentry/);
});

test('non-isolated sandbox clears inherited Redis paths and binds an unreachable endpoint', () => {
  const result = spawnSync(
    process.execPath,
    [
      withTestHome,
      'node',
      '-e',
      `console.log(JSON.stringify([
    process.env.REDIS_URL, ...['REDIS_PORT','REDIS_DATA_DIR','REDIS_BACKUP_DIR','REDIS_KEY_PREFIX'].map(k => process.env[k] ?? null)
  ]))`,
    ],
    {
      env: {
        ...process.env,
        CAT_CAFE_REDIS_TEST_ISOLATED: '',
        REDIS_URL: 'redis://127.0.0.1:6399',
        REDIS_PORT: '6399',
        REDIS_DATA_DIR: '/runtime-sentinel',
        REDIS_BACKUP_DIR: '/backup-sentinel',
        REDIS_KEY_PREFIX: 'runtime:',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['redis://127.0.0.1:0', null, null, null, null]);
});

test('with-test-home propagates the child exit code', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-e', 'process.exit(7)'], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 7);
});

test('with-test-home removes the temporary HOME after the child exits', () => {
  const result = spawnSync(process.execPath, [withTestHome, 'node', '-p', 'process.env.HOME'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, HOME: join(tmpdir(), 'outer-home-sentinel') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const testHome = result.stdout.trim();
  assert.ok(testHome);
  assert.notEqual(testHome, join(tmpdir(), 'outer-home-sentinel'));
  assert.equal(existsSync(testHome), false);
});

test('with-test-home forwards explicit --env assignments', () => {
  const result = spawnSync(
    process.execPath,
    [withTestHome, '--env', 'WITH_TEST_HOME_FLAG=forwarded', 'node', '-p', 'process.env.WITH_TEST_HOME_FLAG'],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, WITH_TEST_HOME_FLAG: 'outer' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'forwarded');
});

test('passes path arguments containing spaces unchanged', () => {
  const output = run(['node', '-e', 'console.log(process.argv.slice(1).join("|"))', 'path with spaces/测试.test.js']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout.trim(), 'path with spaces/测试.test.js');
});

test('terminateChild kills the direct child and its descendants', async () => {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);",
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const [chunk] = await once(parent.stdout, 'data');
  const grandchildPid = Number(String(chunk).trim());
  assert.ok(grandchildPid > 0, `expected grandchild pid, got ${chunk}`);
  terminateChild(parent, 'SIGTERM');
  await Promise.race([
    once(parent, 'close'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('parent did not exit')), 10_000)),
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail('grandchild process is still running');
});
