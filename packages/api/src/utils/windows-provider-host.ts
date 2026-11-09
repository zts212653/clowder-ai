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

import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type CliExecutionOwnerRef, resolveCatCafeDataRoot } from './cli-process-ownership.js';
import { clearWindowsJobExecutionLink, recordWindowsJobExecutionLink } from './windows-job-execution-links.js';
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
  /** The provider's stdin; the host's own stdin is always a pipe, so `ignore` is passed through. */
  stdin?: 'pipe' | 'ignore';
}

export interface WindowsProviderHost {
  /** The job that owns this host and, after launch, the whole provider tree. */
  readonly job: WindowsJobOwnerEntry;
  /** Data root holding the job's owner record; its execution links belong there too. */
  readonly dataDir: string;
  /** Starts the real provider. The returned process is the host: its stdio and exit are the provider's. */
  launch(plan: WindowsProviderLaunch): ChildProcess;
  /** Ends the host if it still runs and reports its job's verdict. Its owner record is kept. */
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
      // The owner record stays: until the caller records the stop, it is how a restart finds this job.
      return evidence;
    },
  };
}
/**
 * Every provider host one execution uses. Each host is linked to the exact execution before it may
 * launch, so after a crash the execution is joinable to all of its jobs; it counts as stopped only
 * when every one of them is verifiably closed, since one closed job says nothing about a writer in
 * another (a startup retry can rebuild its provider within the same execution).
 */
export interface WindowsProviderHostScope {
  readonly execution: CliExecutionOwnerRef;
  /** A linked host to launch the next provider in: the prepared first one, then a new one each time. */
  take(): Promise<WindowsProviderHost>;
  /** Ends every host and reports whether all of their jobs are verifiably closed. */
  close(): Promise<boolean>;
  /**
   * Removes this execution's links and its hosts' owner records together. Only once its stop is
   * recorded: until then they are its only native proof, and a restart needs both to find it.
   */
  clearEvidence(): void;
}

/** Prepares and links the first host. Throws before anything is linked when no host can be owned. */
export async function createWindowsProviderHostScope(options: {
  execution: CliExecutionOwnerRef;
  dataDir?: string;
}): Promise<WindowsProviderHostScope> {
  const hosts: WindowsProviderHost[] = [];
  const linkPaths: string[] = [];
  const prepareLinked = async (): Promise<WindowsProviderHost> => {
    const host = await prepareWindowsProviderHost({ dataDir: options.dataDir });
    // A host whose link cannot be written must not run unaccounted: end it within this owner.
    try {
      linkPaths.push(
        recordWindowsJobExecutionLink({
          dataDir: host.dataDir,
          jobName: host.job.jobName,
          execution: options.execution,
        }).path,
      );
    } catch (error) {
      // No link names this job, so nothing depends on its record once it is verifiably closed.
      if ((await host.close()).verdict === 'absent') clearWindowsJobOwner(host.job.path);
      throw error;
    }
    hosts.push(host);
    return host;
  };
  let first: WindowsProviderHost | undefined = await prepareLinked();
  return {
    execution: options.execution,
    async take() {
      const host = first ?? (await prepareLinked());
      first = undefined;
      return host;
    },
    async close() {
      const verdicts = await Promise.all(hosts.map((host) => host.close()));
      return verdicts.every((evidence) => evidence.verdict === 'absent');
    },
    clearEvidence() {
      for (const path of linkPaths) clearWindowsJobExecutionLink(path);
      for (const host of hosts) clearWindowsJobOwner(host.job.path);
    },
  };
}

const currentScope = new AsyncLocalStorage<WindowsProviderHostScope>();

/** Iterators execute lazily, so next/return/throw each run inside the scope, not just construction. */
export function bindWindowsProviderHostScope<T>(
  create: () => AsyncIterator<T>,
  scope: WindowsProviderHostScope | undefined,
): AsyncIterator<T> {
  if (!scope) return create();
  const iterator = currentScope.run(scope, create);
  const { return: finish, throw: fail } = iterator;
  return {
    next: () => currentScope.run(scope, () => iterator.next()),
    ...(finish ? { return: (value?: T) => currentScope.run(scope, () => finish.call(iterator, value)) } : {}),
    ...(fail ? { throw: (error?: unknown) => currentScope.run(scope, () => fail.call(iterator, error)) } : {}),
  };
}

/**
 * The scope a spawn seam launches in, only for the exact execution it belongs to. Async context
 * also flows into work an invocation merely starts (a title or summary CLI), and such a process
 * must not be counted in, or stopped by, this execution's jobs.
 */
export function windowsProviderHostScopeFor(invocationId: string | undefined): WindowsProviderHostScope | undefined {
  const scope = currentScope.getStore();
  return scope && invocationId !== undefined && scope.execution.invocationId === invocationId ? scope : undefined;
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
  // The API that started this host waits for it, so it is still this process's parent here.
  const adoption = await adoptWindowsApiJob({ dataDir, controllerPid: process.ppid });
  if (!adoption.adopted) {
    process.send?.({ type: 'failed', reason: adoption.reason }, () => process.exit(1));
    return;
  }
  process.once('message', (message) => {
    if (!isLaunch(message)) return process.exit(65);
    const { plan } = message;
    // A provider the caller gave no stdin keeps reading EOF, not a pipe that never closes.
    const stdin = plan.stdin === 'ignore' ? 'ignore' : 'pipe';
    const child = spawn(plan.command, [...plan.args], {
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      ...(plan.env ? { env: plan.env } : {}),
      ...(plan.shell !== undefined ? { shell: plan.shell } : {}),
      stdio: [stdin, 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      process.stdin.pipe(child.stdin);
    }
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    let finished = false;
    // The host exits by itself with the provider's code; leaving the job then reaps any descendant.
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      process.exitCode = code;
      process.off('disconnect', onDisconnect);
      process.stdin.unpipe();
      process.stdin.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
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
