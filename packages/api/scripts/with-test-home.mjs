#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const SUBTREE_POLL_MS = 50;
const NORMAL_SUBTREE_GRACE_MS = 1000;
const CANCEL_SUBTREE_GRACE_MS = 1500;
const CANCEL_SUBTREE_WAIT_MS = 5000;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const CLEARED_ENV_KEYS = [
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_CONFIG_ROOT',
  'CAT_TEMPLATE_PATH',
  'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
  'CAT_CAFE_DATA_DIR',
  'TTS_CACHE_DIR',
  'LISTEN_MODE_DB',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_MCP_SERVER_PATH',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CAT_CAFE_CODEX_CARRIER',
  'CAT_CAFE_CLAUDE_CARRIER',
  'API_SERVER_HOST',
  'DEFAULT_CAT_ID',
  'REDIS_PORT',
  'REDIS_DATA_DIR',
  'REDIS_BACKUP_DIR',
  'REDIS_KEY_PREFIX',
];

function usage() {
  return [
    'Usage: node scripts/with-test-home.mjs [--env KEY=VALUE]... [--] <command> [args...]',
    '',
    'Runs <command> with a temporary HOME, the production environment removed,',
    'and a non-connectable Redis endpoint unless an isolated runner issued one.',
  ].join('\n');
}

function fail(message) {
  console.error(`[with-test-home] ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const env = { ...process.env };
  let index = 0;
  while (index < argv.length && argv[index] === '--env') {
    const assignment = argv[index + 1];
    if (!assignment || !assignment.includes('=')) {
      throw new Error(`--env requires KEY=VALUE, received: ${assignment ?? '<missing>'}`);
    }
    const separator = assignment.indexOf('=');
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    index += 2;
  }
  if (argv[index] === '--') index += 1;
  const [command, ...args] = argv.slice(index);
  if (!command) throw new Error('missing command');
  return { env, command, args };
}

function configureSandbox(env) {
  const realHome = env.CAT_CAFE_TEST_REAL_HOME ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-test-home-')));

  env.HOME = testHome;
  if (isWindows) env.USERPROFILE = testHome;
  env.CAT_CAFE_TEST_SANDBOX = '1';
  env.CAT_CAFE_TEST_REAL_HOME = realHome;
  env.NODE_ENV = 'test';

  for (const key of CLEARED_ENV_KEYS) delete env[key];

  try {
    if (env.CAT_CAFE_REDIS_TEST_ISOLATED === '1') {
      const endpoint = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'redis-test-entrypoint.mjs')], {
        cwd: packageRoot,
        env: { ...env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
        encoding: 'utf8',
      });
      if (endpoint.status !== 0) {
        throw new Error(`isolated Redis validator failed: ${endpoint.stderr.trim() || 'no stderr'}`);
      }
      const redisUrl = endpoint.stdout.trim();
      if (!redisUrl) throw new Error('isolated Redis validator returned an empty endpoint');
      env.REDIS_URL = redisUrl;
    } else {
      env.REDIS_URL = 'redis://127.0.0.1:0';
    }
  } catch (error) {
    rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }

  return testHome;
}

function terminateChild(child, signal) {
  if (!child.pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited between the check and the signal.
    }
  }
}

function processGroupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not signalable by this process.
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroup(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await sleep(SUBTREE_POLL_MS);
  }
  return !processGroupExists(pid);
}

async function settleSubtree(child, canceledSignal) {
  if (!child.pid) return true;

  // taskkill /T /F is synchronous and kills the Windows process tree. There is
  // no portable job-object wait here, so the direct child's close is the
  // strongest confirmation this wrapper can obtain on Windows.
  if (isWindows) return true;

  const grace = canceledSignal ? CANCEL_SUBTREE_GRACE_MS : NORMAL_SUBTREE_GRACE_MS;
  if (await waitForProcessGroup(child.pid, grace)) return true;

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try {
        child.kill('SIGKILL');
      } catch {
        // The group may have exited between the check and the signal.
      }
    }
  }

  return waitForProcessGroup(child.pid, CANCEL_SUBTREE_WAIT_MS);
}

function runCommand(command, args, env) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
      detached: !isWindows,
    });

    let canceledSignal = null;
    const forward = (signal) => {
      canceledSignal ??= signal;
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminateChild(child, signal);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.once('error', (error) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      reject(error);
    });
    child.once('close', (code, signal) => {
      // Keep the signal handlers installed while the descendants finish.
      // Otherwise a second Ctrl-C during the grace period would use Node's
      // default exit path and let the exit hook delete HOME under them.
      settleSubtree(child, canceledSignal)
        .then((subtreeExited) => {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
          resolveExit({ code, signal, subtreeExited });
        })
        .catch((error) => {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
          reject(error);
        });
    });
  });
}

async function main() {
  const { env, command, args } = parseArgs(process.argv.slice(2));
  const testHome = configureSandbox(env);
  let cleaned = false;
  let cleanupAllowed = true;
  const cleanup = () => {
    if (cleaned || !cleanupAllowed) return;
    cleaned = true;
    try {
      rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.error(`[with-test-home] failed to remove ${testHome}: ${error.message}`);
    }
  };
  process.once('exit', cleanup);

  try {
    const outcome = await runCommand(command, args, env);
    cleanupAllowed = outcome.subtreeExited;
    if (!outcome.subtreeExited) {
      console.error(`[with-test-home] retained ${testHome}: descendant processes are still running`);
      process.exitCode = 1;
      return;
    }
    cleanup();
    process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    console.error(usage());
  });
}

export { terminateChild };
