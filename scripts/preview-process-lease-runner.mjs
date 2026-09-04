#!/usr/bin/env node

import { spawn } from 'node:child_process';

const TERM_GRACE_MS = 3_000;

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || argv[0] !== '--expires-at' || !argv[1] || separator !== 2) {
    throw new Error('usage: preview-process-lease-runner --expires-at ISO -- COMMAND [ARGS...]');
  }
  const expiresAt = Date.parse(argv[1]);
  const command = argv.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || command.length === 0) throw new Error('invalid expiry or empty command');
  return { command, expiresAt };
}

function signalOwnedChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait(true);
    });
  });
}

async function terminate(child, reason) {
  process.stderr.write(`[preview-process] ${reason}; terminating managed preview\n`);
  signalOwnedChild(child, 'SIGTERM');
  if (!(await waitForExit(child, TERM_GRACE_MS))) {
    signalOwnedChild(child, 'SIGKILL');
    await waitForExit(child, 1_000);
  }
}

async function main() {
  const { command, expiresAt } = parseArgs(process.argv.slice(2));
  const child = spawn(command[0], command.slice(1), {
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await terminate(child, reason);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown(`received ${signal}`);
    });
  }
  const expiryTimer = setTimeout(
    () => {
      void shutdown(`lease expired at ${new Date(expiresAt).toISOString()}`);
    },
    Math.max(0, expiresAt - Date.now()),
  );
  const outcome = await new Promise((resolveExit) => {
    child.once('exit', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
    child.once('error', (error) => resolveExit({ error }));
  });
  clearTimeout(expiryTimer);
  if (outcome.error) {
    process.stderr.write(`[preview-process] preview command failed to start: ${outcome.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!shuttingDown) process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[preview-process] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
