import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCatCliProcessContext } from '../../utils/cli-process-environment.js';
import { isParseError, parseNDJSON } from '../../utils/ndjson-parser.js';
import { excerptSanitizedStderr } from '../../utils/sanitize-cli-stderr.js';
import type {
  AgentCarrierSession,
  AgentCarrierSessionFactory,
  AgentCarrierSessionOptions,
} from '../cats/services/types.js';
import type { AgentPaneRegistry } from './agent-pane-registry.js';
import { execTmuxClientCommand as execAsync } from './tmux-client-command.js';
import { paneUtility, shellEscape, writeAgentCommandFile } from './tmux-command-file.js';
import type { TmuxGateway } from './tmux-gateway.js';
import type { PaneLease } from './tmux-pane-lease.js';

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
    `| ${shellEscape(paneUtility('tee'))} ${shellEscape(outputPath)}; echo "EXIT:$?" > ${shellEscape(exitPath)}`
  );
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

export function buildTmuxAgentCarrierExitError(exitCode: number, stderr: string): Error {
  const excerpt = excerptSanitizedStderr(stderr, { edge: 'tail', maxLength: 1_000 });
  return new Error(`Codex app-server exited with code ${exitCode}${excerpt ? `: ${excerpt}` : ''}`);
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
      lease: PaneLease;
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
      this.context.tmuxGateway.killAgentPane(this.context.lease);
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
        throw buildTmuxAgentCarrierExitError(exitCode, stderr);
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
    this.context.tmuxGateway.killAgentPane(this.context.lease);
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
    options.signal?.throwIfAborted();
    const tmpDir = await mkdtemp(join(tmpdir(), `catcafe-agent-duplex-${options.invocationId}-`));
    const inputPath = join(tmpDir, 'input.fifo');
    const outputPath = join(tmpDir, 'output.fifo');
    const stderrPath = join(tmpDir, 'stderr.log');
    const exitPath = join(tmpDir, 'exit-code');
    let lease: PaneLease | undefined;
    try {
      await execAsync('mkfifo', [inputPath, outputPath], { signal: options.signal });
      const command = await writeAgentCommandFile(
        tmpDir,
        { cwd: options.cwd, env: withCatCliProcessContext(options.env ?? {}) },
        buildTmuxAgentCarrierPaneCommand(options, inputPath, outputPath, stderrPath, exitPath),
      );
      lease = await input.tmuxGateway.createAgentPaneLease(input.worktreeId, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        signal: options.signal,
        command,
      });
      options.signal?.throwIfAborted();
      if (!input.tmuxGateway.setAgentPaneReadOnly(lease)) throw new Error('Agent pane was replaced during setup');
      input.agentPaneRegistry?.register(options.invocationId, input.worktreeId, lease.paneId, input.userId);
      const session = new TmuxAgentCarrierSession(options, {
        worktreeId: input.worktreeId,
        userId: input.userId,
        lease,
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
      if (lease) input.tmuxGateway.killAgentPane(lease);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };
}
