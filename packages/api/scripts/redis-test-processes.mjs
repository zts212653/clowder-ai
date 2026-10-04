import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cleanupGateJobProcesses,
  REDIS_TEST_COMMAND_TOKEN_ENV,
  REDIS_TEST_ROOT_TOKEN_ENV,
} from '../../../scripts/lib/gate-job-processes.mjs';

export function spawnTracked(command, args, options) {
  const child = spawn(command, args, options);
  const tracked = { child, ended: false, result: null };
  tracked.done = new Promise((resolve) => {
    const finish = (result) => {
      tracked.ended = true;
      tracked.result = result;
      resolve(result);
    };
    child.on('error', (error) => {
      // A failed spawn has no child. An error sending a signal is not an exit.
      if (!child.pid) finish({ code: error.code === 'ENOENT' ? 127 : 1, error });
    });
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
  return tracked;
}

async function waitForExit(tracked, timeoutMs) {
  const controller = new AbortController();
  try {
    await Promise.race([tracked.done, delay(timeoutMs, undefined, { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
  return tracked.ended;
}

export async function stopTracked(tracked) {
  if (!tracked || tracked.ended) return;
  for (const [signal, timeoutMs] of [
    ['SIGTERM', 2000],
    ['SIGKILL', 1000],
  ]) {
    if (tracked.ended) return;
    tracked.child.kill(signal);
    if (await waitForExit(tracked, timeoutMs)) return;
  }
  tracked.child.unref();
  throw new Error(`cannot confirm child ${tracked.child.pid} exited; preserving its lease and directory`);
}

export async function runTestCommand(command, { cwd, env, signal }) {
  signal.throwIfAborted();
  const token = randomUUID();
  const inheritedRoot = env[REDIS_TEST_ROOT_TOKEN_ENV];
  const tracked = spawnTracked(command[0], command.slice(1), {
    cwd,
    stdio: 'inherit',
    // A separate token preserves the enclosing gate's job/root/local ownership.
    env: { ...env, [REDIS_TEST_ROOT_TOKEN_ENV]: inheritedRoot ?? token, [REDIS_TEST_COMMAND_TOKEN_ENV]: token },
  });
  let onAbort;
  const cancel = new Promise((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([tracked.done, cancel]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const proof = await cleanupGateJobProcesses({
    jobToken: token,
    tokenEnvironmentKey: inheritedRoot ? REDIS_TEST_COMMAND_TOKEN_ENV : REDIS_TEST_ROOT_TOKEN_ENV,
    cleanupBudgetMs: 4000,
    killGraceMs: 2000,
    settleGraceMs: 100,
    isCommandClosed: () => tracked.ended,
  });
  if (!proof.tokenZeroMatches || proof.killedPids.length > 0) {
    console.error(`[redis-test] command descendants cleanup=${proof.status} killed=${proof.killedPids.length}`);
    if (!proof.tokenZeroMatches) tracked.child.unref();
    return 1;
  }
  if (tracked.result.error) console.error(`[redis-test] ${tracked.result.error.message}`);
  return tracked.result.code ?? 128 + constants.signals[tracked.result.signal];
}
