/**
 * #1838: one Windows kernel job per real provider, with the API outside every job.
 *
 * An API-wide job reaped the provider tree after an API crash, but it also took every background
 * service and managed job the API started, which are meant to survive an API restart. So the job
 * moves down to the provider: each provider gets a host, a small node process that puts itself into
 * its own job through the existing helper and only then reports ready. The caller persists the exact
 * execution link and passes its provider fence before it sends `launch`; the host then starts the
 * real command, so the provider and every descendant, including a writer whose launcher already
 * exited, belong to that one job from their first instruction.
 *
 * Whatever ends the host closes its job and the kernel reaps that tree: a Stop that kills the host,
 * an API crash (the IPC channel closes and the host exits), or the host itself dying. Nothing else
 * the API started is a member. A host exit alone is not stop evidence: the helper closes the job a
 * moment later, so `close` reports the job's own verdict.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveCatCafeDataRoot } from './cli-process-ownership.js';
import {
  adoptWindowsApiJob,
  clearWindowsJobOwner,
  parseWindowsJobOwnerRecord,
  queryWindowsJobStopEvidence,
  type WindowsJobOwnerEntry,
  type WindowsJobStopEvidence,
} from './windows-job-owner.js';

const HOST_SCRIPT = fileURLToPath(import.meta.url);
// Adoption is one PowerShell start plus Add-Type, about a second; the helper's own bound is 10s.
const READY_TIMEOUT_MS = 20_000;
// After the host exits the helper still has to close the job, so a present verdict is re-read.
const CLOSE_QUERY_ATTEMPTS = 5;
const CLOSE_QUERY_INTERVAL_MS = 300;
// A descendant can keep the provider's pipes open after it exits; its output gets this long.
const OUTPUT_GRACE_MS = 2_000;

export interface WindowsProviderLaunch {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean | string;
}

export interface WindowsProviderHost {
  /** The job that owns this host and, after launch, the whole provider tree. */
  readonly job: WindowsJobOwnerEntry;
  /** Data root holding the job's owner record; its execution links belong there too. */
  readonly dataDir: string;
  /** Starts the real provider. The returned process is the host: its stdio and exit are the provider's. */
  launch(plan: WindowsProviderLaunch): ChildProcess;
  /** Ends the host if it still runs and reports its job's verdict; an absent job's record is removed. */
  close(): Promise<WindowsJobStopEvidence>;
}

function readyJob(message: unknown, hostPid: number | undefined): WindowsJobOwnerEntry | null {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'ready') return null;
  if (!('record' in message) || !('path' in message) || typeof message.path !== 'string') return null;
  const record = parseWindowsJobOwnerRecord(message.record);
  // The job must own exactly this host, or the link written for it would name someone else's job.
  return record && record.apiPid === hostPid ? { ...record, path: message.path } : null;
}

/**
 * Start a provider host and wait until its job owns it. Throws a recoverable error when the host
 * cannot be owned in time; nothing has been launched then, and the host is already ended.
 */
export async function prepareWindowsProviderHost(options: { dataDir?: string } = {}): Promise<WindowsProviderHost> {
  const dataDir = resolveCatCafeDataRoot(options.dataDir);
  const nodeArgs = HOST_SCRIPT.endsWith('.ts') ? [...process.execArgv, HOST_SCRIPT] : [HOST_SCRIPT];
  const host = spawn(process.execPath, [...nodeArgs, dataDir], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
  const ready = await new Promise<WindowsJobOwnerEntry | string>((resolve) => {
    const timer = setTimeout(() => resolve('host_ready_timeout'), READY_TIMEOUT_MS);
    const finish = (value: WindowsJobOwnerEntry | string): void => {
      clearTimeout(timer);
      resolve(value);
    };
    host.once('message', (message) => {
      finish(readyJob(message, host.pid) ?? `host_not_ready:${JSON.stringify(message).slice(0, 500)}`);
    });
    host.once('exit', (code) => finish(`host_exited:${code}`));
    host.once('error', (error) => finish(`host_spawn_failed:${error.message}`));
  });
  if (typeof ready === 'string') {
    // A host that the helper already assigned takes its job down with it; nothing was launched.
    host.kill();
    throw new Error(`windows_provider_host_unavailable:${ready}`);
  }

  let launched = false;
  return {
    job: ready,
    dataDir,
    launch(plan) {
      if (launched) throw new Error('windows_provider_host_already_launched');
      // An exited host would hand the caller a process whose exit it can no longer observe.
      if (host.exitCode !== null || host.signalCode !== null) throw new Error('windows_provider_host_exited');
      launched = true;
      host.send({ type: 'launch', plan }, (error) => {
        if (error) host.kill();
      });
      return host;
    },
    async close() {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await exited;
      let evidence = await queryWindowsJobStopEvidence(ready);
      for (let attempt = 1; evidence.verdict === 'present' && attempt < CLOSE_QUERY_ATTEMPTS; attempt += 1) {
        await delay(CLOSE_QUERY_INTERVAL_MS);
        evidence = await queryWindowsJobStopEvidence(ready);
      }
      if (evidence.verdict === 'absent') clearWindowsJobOwner(ready.path);
      return evidence;
    },
  };
}
function isLaunch(message: unknown): message is { type: 'launch'; plan: WindowsProviderLaunch } {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'launch')
    return false;
  if (!('plan' in message) || typeof message.plan !== 'object' || message.plan === null) return false;
  const plan = message.plan;
  return (
    'command' in plan &&
    typeof plan.command === 'string' &&
    'args' in plan &&
    Array.isArray(plan.args) &&
    plan.args.every((arg) => typeof arg === 'string')
  );
}

/** The host process: own the job first, start the provider only on `launch`, mirror its stdio and exit. */
async function runHost(dataDir: string): Promise<void> {
  // An API that dies before launch leaves nothing to start; during the run this ends the tree.
  const onDisconnect = (): void => process.exit(0);
  process.once('disconnect', onDisconnect);
  const adoption = await adoptWindowsApiJob({ dataDir });
  if (!adoption.adopted) {
    process.send?.({ type: 'failed', reason: adoption.reason }, () => process.exit(1));
    return;
  }
  process.once('message', (message) => {
    if (!isLaunch(message)) return process.exit(65);
    const { plan } = message;
    const child = spawn(plan.command, [...plan.args], {
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      ...(plan.env ? { env: plan.env } : {}),
      ...(plan.shell !== undefined ? { shell: plan.shell } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.on('error', () => {});
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    let finished = false;
    // The host exits by itself with the provider's code; leaving the job then reaps any descendant.
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      process.exitCode = code;
      process.off('disconnect', onDisconnect);
      process.stdin.unpipe(child.stdin);
      process.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      process.disconnect?.();
    };
    child.once('error', (error) => {
      process.stderr.write(`[cat-cafe-provider-host] spawn failed: ${error.message}\n`);
      finish('code' in error && error.code === 'ENOENT' ? 127 : 1);
    });
    child.once('exit', (code) => {
      const exitCode = code ?? 1;
      child.once('close', () => finish(exitCode));
      setTimeout(() => finish(exitCode), OUTPUT_GRACE_MS).unref();
    });
  });
  process.send?.({ type: 'ready', record: adoption.job.record, path: adoption.job.record.path });
}

if (process.argv[1] === HOST_SCRIPT) {
  const dataDir = process.argv[2];
  if (!dataDir) process.exit(64);
  void runHost(dataDir);
}
