#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
// Windows CreateProcess limits the command line to 32767 characters, and cmd.exe
// has a much smaller practical limit. Keep each child well below it; the
// resolver can return more files than a single argv can carry.
const MAX_ARGV_CHARS = 6000;
// The serial public lane must never inherit a legal isolated Redis runner's
// endpoint. This mirrors run-public-tests.sh's REDIS_URL=redis://127.0.0.1:0
// boundary and keeps public tests from touching a shared Redis by accident.
const PUBLIC_TEST_REDIS_URL = 'redis://127.0.0.1:0';

function fail(message) {
  console.error(`[run-public-tests] ${message}`);
  process.exitCode = 1;
}

function resolveFiles(resolverPath = join(packageRoot, 'scripts', 'resolve-public-test-files.mjs')) {
  const resolver = spawnSync(process.execPath, [resolverPath], {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (resolver.error) throw resolver.error;
  if (resolver.status !== 0) {
    throw new Error(`public-test resolver exited ${resolver.status}: ${resolver.stderr.trim() || 'no stderr'}`);
  }
  const files = resolver.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) {
    throw new Error('public-test resolver returned an empty file set; refusing full-tree discovery');
  }
  return files;
}

function chunkFiles(files, baseArgs) {
  const chunks = [];
  const baseLength = baseArgs.reduce((length, arg) => length + arg.length + 1, 0);
  let chunk = [];
  let length = baseLength;
  for (const file of files) {
    const nextLength = length + file.length + 1;
    if (chunk.length > 0 && nextLength > MAX_ARGV_CHARS) {
      chunks.push(chunk);
      chunk = [];
      length = baseLength;
    }
    chunk.push(file);
    length += file.length + 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
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

function run(files, options = {}) {
  const baseArgs = [
    '--import',
    pathToFileURL(join(packageRoot, 'test', 'helpers', 'setup-cat-registry.js')).href,
    '--test',
    '--test-concurrency=1',
  ];
  const chunks = chunkFiles(files, baseArgs);

  return (async () => {
    for (const chunk of chunks) {
      const outcome = await new Promise((resolveExit, reject) => {
        const childEnv = { ...(options.env ?? process.env), REDIS_URL: PUBLIC_TEST_REDIS_URL };
        // A nested node --test invocation must not inherit the outer test
        // runner's child marker, or Node treats the fixture as an IPC child.
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, [...baseArgs, ...chunk], {
          cwd: packageRoot,
          env: childEnv,
          stdio: 'inherit',
          windowsHide: true,
          detached: !isWindows,
        });
        const forward = (signal) => {
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
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
          resolveExit({ code, signal });
        });
      });
      if (outcome.code !== 0 || outcome.signal) return outcome;
    }
    return { code: 0, signal: null };
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const files = resolveFiles();
    const outcome = await run(files);
    process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export { chunkFiles, PUBLIC_TEST_REDIS_URL, resolveFiles, run };
