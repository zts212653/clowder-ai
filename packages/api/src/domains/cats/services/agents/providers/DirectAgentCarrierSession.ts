import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildChildEnv } from '../../../../../utils/cli-spawn.js';
import { buildUnixSupervisedSpawnPlan } from '../../../../../utils/cli-supervised-process.js';
import { isParseError, parseNDJSON } from '../../../../../utils/ndjson-parser.js';
import type { AgentCarrierSession, AgentCarrierSessionFactory, AgentCarrierSessionOptions } from '../../types.js';

function normalizeEnv(input: Record<string, string | null> | undefined, workingDirectory: string): NodeJS.ProcessEnv {
  return buildChildEnv(input, { workingDirectory });
}

class DirectAgentCarrierSession implements AgentCarrierSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderr: string[] = [];
  private closed = false;
  private readonly abortHandler: () => void;

  constructor(private readonly options: AgentCarrierSessionOptions) {
    const childCwd = options.cwd ?? process.cwd();
    const env = normalizeEnv(options.env, childCwd);
    const launch =
      process.platform === 'win32'
        ? { command: options.command, args: [...options.args], env }
        : buildUnixSupervisedSpawnPlan(options.command, options.args, {
            env,
            killGraceMs: 500,
          });
    this.child = spawn(launch.command, launch.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      if (this.stderr.join('').length < 8192) this.stderr.push(chunk);
    });
    this.abortHandler = () => {
      if (!this.child.killed) this.child.kill('SIGINT');
    };
    if (options.signal?.aborted) this.abortHandler();
    else options.signal?.addEventListener('abort', this.abortHandler, { once: true });
  }

  async *read(): AsyncIterable<unknown> {
    for await (const value of parseNDJSON(this.child.stdout)) {
      if (isParseError(value)) {
        throw new Error(`Codex app-server emitted non-JSON stdout: ${value.line.slice(0, 240)}`);
      }
      yield value;
    }
    const exit = await this.waitForExit();
    if (exit.code !== 0 && !this.options.signal?.aborted) {
      const excerpt = this.stderr.join('').trim().slice(-1000);
      throw new Error(`Codex app-server exited with code ${String(exit.code)}${excerpt ? `: ${excerpt}` : ''}`);
    }
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

export const createDirectAgentCarrierSession: AgentCarrierSessionFactory = async (options) =>
  new DirectAgentCarrierSession(options);
