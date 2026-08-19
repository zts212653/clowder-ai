import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isParseError, parseNDJSON } from '../../utils/ndjson-parser.js';
import type {
  AgentCarrierSession,
  AgentCarrierSessionFactory,
  AgentCarrierSessionOptions,
} from '../cats/services/types.js';
import type { AgentPaneRegistry } from './agent-pane-registry.js';
import type { TmuxGateway } from './tmux-gateway.js';

const execAsync = promisify(execFile);

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function buildTmuxAgentCarrierPaneCommand(
  options: AgentCarrierSessionOptions,
  inputPath: string,
  outputPath: string,
  stderrPath: string,
  exitPath: string,
): string {
  const command = [shellEscape(options.command), ...options.args.map(shellEscape)].join(' ');
  return (
    `set -o pipefail; ${command} < ${shellEscape(inputPath)} 2> ${shellEscape(stderrPath)} ` +
    `| tee ${shellEscape(outputPath)}; echo "EXIT:$?" > ${shellEscape(exitPath)}`
  );
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid tmux carrier environment key: ${JSON.stringify(key)}`);
  }
}

async function readExitCode(path: string): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const match = /^EXIT:(\d+)$/.exec((await readFile(path, 'utf8')).trim());
      if (match) return Number(match[1]);
    } catch {
      // The FIFO can close just before the shell writes the exit sentinel.
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

class TmuxAgentCarrierSession implements AgentCarrierSession {
  private input: WriteStream | null = null;
  private output: ReadStream | null = null;
  private closed = false;
  private readFinished = false;
  private readonly abortHandler: () => void;

  constructor(
    private readonly options: AgentCarrierSessionOptions,
    private readonly context: {
      worktreeId: string;
      userId: string;
      paneId: string;
      inputPath: string;
      outputPath: string;
      stderrPath: string;
      exitPath: string;
      tmpDir: string;
      tmuxGateway: TmuxGateway;
      agentPaneRegistry?: AgentPaneRegistry;
    },
  ) {
    this.abortHandler = () => {
      void this.context.tmuxGateway.killPane(this.context.worktreeId, this.context.paneId);
      this.input?.destroy();
      this.output?.destroy();
    };
    if (options.signal?.aborted) this.abortHandler();
    else options.signal?.addEventListener('abort', this.abortHandler, { once: true });
  }

  start(): void {
    this.input = createWriteStream(this.context.inputPath, { encoding: 'utf8' });
    this.output = createReadStream(this.context.outputPath, { encoding: 'utf8' });
  }

  async *read(): AsyncIterable<unknown> {
    if (!this.output) throw new Error('tmux agent carrier session was not started');
    try {
      for await (const value of parseNDJSON(this.output)) {
        if (isParseError(value)) {
          throw new Error(`Codex app-server emitted non-JSON stdout in tmux: ${value.line.slice(0, 240)}`);
        }
        yield value;
      }
      const exitCode = await readExitCode(this.context.exitPath);
      this.context.agentPaneRegistry?.markDone(this.options.invocationId, exitCode);
      if (exitCode !== null && exitCode !== 0 && !this.options.signal?.aborted) {
        const stderr = await readFile(this.context.stderrPath, 'utf8').catch(() => '');
        throw new Error(`Codex app-server exited with code ${exitCode}${stderr ? `: ${stderr.slice(-1000)}` : ''}`);
      }
    } catch (error) {
      this.context.agentPaneRegistry?.markCrashed(
        this.options.invocationId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.readFinished = true;
      await this.cleanup();
    }
  }

  async write(message: Record<string, unknown>): Promise<void> {
    if (this.closed || !this.input || this.input.destroyed) throw new Error('tmux agent carrier input is closed');
    await new Promise<void>((resolve, reject) => {
      this.input?.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.abortHandler);
    if (this.input && !this.input.destroyed) {
      await new Promise<void>((resolve) => this.input?.end(resolve));
    }
    if (!this.readFinished && !(await this.waitForReadFinished(1_500))) {
      await this.terminate();
    }
    if (this.readFinished) await this.cleanup();
  }

  async terminate(): Promise<void> {
    await this.context.tmuxGateway.killPane(this.context.worktreeId, this.context.paneId).catch(() => {});
    this.input?.destroy();
    this.output?.destroy();
  }

  private async waitForReadFinished(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.readFinished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.readFinished;
  }

  private async cleanup(): Promise<void> {
    if (!this.closed || !this.readFinished) return;
    this.output?.destroy();
    await rm(this.context.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createTmuxAgentCarrierSessionFactory(input: {
  worktreeId: string;
  userId: string;
  tmuxGateway: TmuxGateway;
  agentPaneRegistry?: AgentPaneRegistry;
}): AgentCarrierSessionFactory {
  return async (options) => {
    const tmpDir = await mkdtemp(join(tmpdir(), `catcafe-agent-duplex-${options.invocationId}-`));
    const inputPath = join(tmpDir, 'input.fifo');
    const outputPath = join(tmpDir, 'output.fifo');
    const stderrPath = join(tmpDir, 'stderr.log');
    const exitPath = join(tmpDir, 'exit-code');
    try {
      await Promise.all([execAsync('mkfifo', [inputPath]), execAsync('mkfifo', [outputPath])]);
      await input.tmuxGateway.ensureServer(input.worktreeId);
      const paneId = await input.tmuxGateway.createAgentPane(input.worktreeId, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value !== null) {
          assertSafeEnvKey(key);
          await input.tmuxGateway.execInPane(input.worktreeId, paneId, `export ${key}=${shellEscape(value)}`);
        }
      }
      await input.tmuxGateway.execInPane(
        input.worktreeId,
        paneId,
        buildTmuxAgentCarrierPaneCommand(options, inputPath, outputPath, stderrPath, exitPath),
      );
      await input.tmuxGateway.setPaneReadOnly(input.worktreeId, paneId, true);
      input.agentPaneRegistry?.register(options.invocationId, input.worktreeId, paneId, input.userId);
      const session = new TmuxAgentCarrierSession(options, {
        worktreeId: input.worktreeId,
        userId: input.userId,
        paneId,
        inputPath,
        outputPath,
        stderrPath,
        exitPath,
        tmpDir,
        tmuxGateway: input.tmuxGateway,
        ...(input.agentPaneRegistry ? { agentPaneRegistry: input.agentPaneRegistry } : {}),
      });
      session.start();
      return session;
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };
}
