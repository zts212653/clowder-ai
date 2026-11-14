import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { observeCliExecutionProcess } from '../../../../../utils/CliExecutionObservation.js';
import { CliExitOutputDrain } from '../../../../../utils/CliExitOutputDrain.js';
import type { CliExecutionOwnerRef } from '../../../../../utils/cli-process-ownership.js';
import { buildChildEnv } from '../../../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../../../../utils/cli-spawn-win.js';
import { buildUnixSupervisedSpawnPlan } from '../../../../../utils/cli-supervised-process.js';
import { isParseError, parseNDJSON } from '../../../../../utils/ndjson-parser.js';
import { excerptSanitizedStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { createStderrTail, type StderrTail } from '../../../../../utils/stderr-tail.js';
import { type WindowsProviderHost, windowsProviderHostScopeFor } from '../../../../../utils/windows-provider-host.js';
import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';
import { codexHostServedModels } from './codex-served-model.js';

/** Bounded stderr kept per direct session for exit diagnostics (pre-F319 value). */
const DIRECT_STDERR_TAIL_CHARS = 8192;

/** The session only uses these three pipes, which both a direct spawn and a provider host open. */
type PipedChild = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

export interface DirectAgentCarrierSessionDeps {
  /** Server-owned per-turn identity; never derive it from ambient or warm-host environment. */
  executionOwner?: CliExecutionOwnerRef;
  windowsSpawnPlan?: typeof resolveWindowsSpawnPlan;
  /** Host-prepared complete environment; ordinary provider sessions still inherit normally. */
  finalEnvironment?: Readonly<NodeJS.ProcessEnv>;
  /** #1838: a linked Windows provider host this session's provider starts in. */
  windowsHost?: WindowsProviderHost;
}

/** The host's stdio is opened as pipes; this checks that once where the session needs all three. */
function launchInHost(
  host: WindowsProviderHost,
  plan: { command: string; args: string[]; shell?: boolean | string; env: NodeJS.ProcessEnv; cwd?: string },
): PipedChild {
  const child = host.launch({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    ...(plan.cwd ? { cwd: plan.cwd } : {}),
    ...(plan.shell !== undefined ? { shell: plan.shell } : {}),
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error('windows_provider_host_without_pipes');
  }
  return Object.assign(child, { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr });
}

function normalizeEnv(
  input: Record<string, string | null> | undefined,
  workingDirectory: string,
  inheritParentEnv?: boolean,
): NodeJS.ProcessEnv {
  return buildChildEnv(input, { workingDirectory, inheritParentEnv });
}

class DirectAgentCarrierSession implements AgentCarrierSession {
  private readonly child: PipedChild;
  // F319 Phase B: every stderr line is offered to the served-model registry
  // (trace lines only exist when observation is on); the diagnostic tail stays bounded.
  private readonly stderr: StderrTail = createStderrTail({
    maxChars: DIRECT_STDERR_TAIL_CHARS,
    onLine: (line) => codexHostServedModels.ingestStderrLine(line),
  });
  private readonly stdoutDrain: CliExitOutputDrain;
  private readonly stdioClosed: Promise<void>;
  private readonly drainComplete: Promise<void>;
  private exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  private exitObserved = false;
  private readFinished = false;
  private closed = false;
  private readonly abortHandler: () => void;

  constructor(
    private readonly options: AgentCarrierSessionOptions,
    deps: DirectAgentCarrierSessionDeps,
  ) {
    options.signal?.throwIfAborted();
    if (deps.executionOwner && deps.executionOwner.invocationId !== options.invocationId) {
      throw new Error('direct_carrier_owner_mismatch');
    }
    const childCwd = options.cwd ?? process.cwd();
    const env = deps.finalEnvironment
      ? { ...deps.finalEnvironment }
      : normalizeEnv(options.env, childCwd, options.inheritParentEnv);
    const windowsPlan =
      process.platform === 'win32'
        ? (deps.windowsSpawnPlan ?? resolveWindowsSpawnPlan)(options.command, options.args)
        : undefined;
    const launch = windowsPlan
      ? { ...windowsPlan, env: { ...env, ...windowsPlan.env } }
      : buildUnixSupervisedSpawnPlan(options.command, options.args, {
          env,
          killGraceMs: 500,
        });
    const shell =
      'shell' in launch && (typeof launch.shell === 'string' || typeof launch.shell === 'boolean')
        ? launch.shell
        : false;
    // #1838: the same Windows plan, started in a linked host whose own job owns the whole tree.
    this.child = deps.windowsHost
      ? launchInHost(deps.windowsHost, {
          command: launch.command,
          args: launch.args,
          env: launch.env,
          shell,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        })
      : spawn(launch.command, launch.args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: launch.env,
          windowsHide: true,
          shell,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    observeCliExecutionProcess(this.child, deps.executionOwner);
    this.stdoutDrain = new CliExitOutputDrain(this.child.stdout);
    this.stdioClosed = new Promise((resolve) => this.child.once('close', () => resolve()));
    let completeDrain: () => void;
    this.drainComplete = new Promise((resolve) => {
      completeDrain = resolve;
    });
    const observeExit = (): void => {
      if (this.exitObserved) return;
      this.exitObserved = true;
      if (this.readFinished) {
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        completeDrain();
        return;
      }
      this.stdoutDrain.start();
      this.exitDrainTimer = setTimeout(() => {
        this.stdoutDrain.finish();
        this.child.stderr.destroy();
        completeDrain();
      }, 1_000);
    };
    this.child.once('exit', observeExit);
    this.child.once('close', observeExit);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.append(chunk));
    this.child.stderr.once('end', () => this.stderr.flush());
    this.abortHandler = () => {
      if (this.isAlive() && !this.child.killed) this.child.kill('SIGINT');
    };
    if (options.signal?.aborted) this.abortHandler();
    else options.signal?.addEventListener('abort', this.abortHandler, { once: true });
  }

  async *read(): AsyncIterable<unknown> {
    try {
      for await (const value of parseNDJSON(this.stdoutDrain.stream)) {
        if (isParseError(value)) {
          throw new Error(`Codex app-server emitted non-JSON stdout: ${value.line.slice(0, 240)}`);
        }
        yield value;
      }
      const exit = await this.waitForExit();
      await Promise.race([this.stdioClosed, this.drainComplete]);
      if (exit.code !== 0 && !this.options.signal?.aborted) {
        const excerpt = excerptSanitizedStderr(this.stderr.value, { edge: 'tail', maxLength: 1_000 });
        throw new Error(`Codex app-server exited with code ${String(exit.code)}${excerpt ? `: ${excerpt}` : ''}`);
      }
    } finally {
      this.readFinished = true;
      if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
      this.stdoutDrain.dispose();
      if (this.exitObserved) {
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async write(message: Record<string, unknown>): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Codex app-server input is closed');
    if (!this.child.stdin.write(`${JSON.stringify(message)}\n`)) await once(this.child.stdin, 'drain');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.abortHandler);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if ((await this.waitForExitWithin(1_500)) === null && this.isAlive()) {
        this.child.kill('SIGTERM');
      }
      if ((await this.waitForExitWithin(1_000)) === null && this.isAlive()) {
        this.child.kill('SIGKILL');
        await this.waitForExit();
      }
    }
  }

  async terminate(): Promise<void> {
    if (!this.isAlive()) return;
    this.child.kill('SIGTERM');
    if ((await this.waitForExitWithin(1_000)) === null && this.isAlive()) {
      this.child.kill('SIGKILL');
      await this.waitForExit();
    }
  }

  private isAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private async waitForExitWithin(
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    if (!this.isAlive()) return { code: this.child.exitCode, signal: this.child.signalCode };
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return Promise.race([this.waitForExit(), timeout]);
  }

  private async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    const [code, signal] = (await once(this.child, 'exit')) as [number | null, NodeJS.Signals | null];
    return { code, signal };
  }
}

export async function createDirectAgentCarrierSession(
  options: AgentCarrierSessionOptions,
  deps: DirectAgentCarrierSessionDeps = {},
): Promise<AgentCarrierSession> {
  // #1838: a session of the turn whose host scope is current takes a linked host first. Sessions
  // with any other invocationId (read-only commands, metadata reads) are not this execution's.
  const hostScope =
    process.platform === 'win32' && !deps.windowsHost ? windowsProviderHostScopeFor(options.invocationId) : undefined;
  if (hostScope) {
    options.signal?.throwIfAborted();
    return new DirectAgentCarrierSession(options, { ...deps, windowsHost: await hostScope.take() });
  }
  return new DirectAgentCarrierSession(options, deps);
}
