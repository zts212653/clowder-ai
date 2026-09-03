import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasDurableGateCancellationRequestArtifact } from '../domains/ball-custody/durable-managed-gate-cancellation.js';
import {
  type DurableManagedGateJob,
  recordDurableManagedGateProcess,
  validateDurableManagedGateJob,
} from '../domains/ball-custody/durable-managed-gate-job.js';
import { readUnixProcessSnapshotSync } from '../utils/cli-process-ownership.js';

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from('\n[managed-runner log truncated; final bytes follow]\n');
const HEAD_BYTES = MAX_LOG_BYTES - TAIL_BYTES - TRUNCATION_MARKER.length;

const command = process.env.CAT_CAFE_MANAGED_RUNNER_COMMAND;
const logPath = process.env.CAT_CAFE_MANAGED_JOB_LOG_PATH;
const descriptorJson = process.env.CAT_CAFE_MANAGED_JOB_DESCRIPTOR;
const cwd = process.env.CAT_CAFE_MANAGED_RUNNER_CWD || undefined;
if (!command || !logPath || !descriptorJson) process.exit(64);

let durableJob: DurableManagedGateJob;
try {
  durableJob = JSON.parse(descriptorJson) as DurableManagedGateJob;
} catch {
  process.exit(64);
}
if (
  !durableJob ||
  typeof durableJob.originTaskId !== 'string' ||
  !validateDurableManagedGateJob(durableJob, durableJob.originTaskId) ||
  logPath !== durableJob.logPath
)
  process.exit(64);

const childEnv = { ...process.env };
delete childEnv.CAT_CAFE_MANAGED_RUNNER_COMMAND;
delete childEnv.CAT_CAFE_MANAGED_RUNNER_CWD;
delete childEnv.CAT_CAFE_MANAGED_JOB_DESCRIPTOR;

mkdirSync(dirname(logPath), { recursive: true });
const logFd = openSync(logPath, 'w');
let headBytes = 0;
let tail = Buffer.alloc(0);
let truncated = false;
let logOpen = true;
let terminationTimer: ReturnType<typeof setTimeout> | null = null;

function capture(chunk: Buffer): void {
  if (!logOpen) return;
  let writtenFromChunk = 0;
  if (headBytes < HEAD_BYTES) {
    const headChunk = chunk.subarray(0, Math.min(chunk.length, HEAD_BYTES - headBytes));
    writeSync(logFd, headChunk);
    headBytes += headChunk.length;
    writtenFromChunk = headChunk.length;
  }
  if (writtenFromChunk < chunk.length) truncated = true;
  tail = Buffer.concat([tail, chunk]);
  if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
}

function finishLog(): void {
  if (!logOpen) return;
  if (truncated) {
    writeSync(logFd, TRUNCATION_MARKER);
    writeSync(logFd, tail);
  }
  closeSync(logFd);
  logOpen = false;
}

function failClosedBeforeExecution(message: string): never {
  capture(Buffer.from(`${message}\n`));
  finishLog();
  process.exit(70);
}

const workerIdentity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
if (!workerIdentity || !recordDurableManagedGateProcess(durableJob, workerIdentity)) {
  failClosedBeforeExecution('durable worker birth registration failed; command was not executed');
}
if (hasDurableGateCancellationRequestArtifact(durableJob)) {
  failClosedBeforeExecution('durable worker cancellation was requested before execution; command was not executed');
}

const child = spawn(command, {
  shell: true,
  cwd,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (terminationTimer) return;
    terminationTimer = setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }, 5_000);
  });
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', (error) => {
  capture(Buffer.from(`managed command spawn error: ${error.message}\n`));
  finishLog();
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  if (terminationTimer) clearTimeout(terminationTimer);
  finishLog();
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
