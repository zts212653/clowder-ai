/**
 * CLI Parser Types
 * CLI 子进程解析器的共享类型定义
 */

import type { Readable } from 'node:stream';
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../domains/cats/services/types.js';

/**
 * Options for spawning a CLI process
 */
export interface CliSpawnOptions {
  /** The CLI command to execute (e.g., 'claude', 'codex') */
  command: string;
  /** Arguments to pass to the CLI */
  args: readonly string[];
  /** Working directory for the process */
  cwd?: string;
  /** Timeout in milliseconds before auto-kill (default: 300_000 = 5 min) */
  timeoutMs?: number;
  /** AbortSignal to cancel the process externally */
  signal?: AbortSignal;
  /** Environment overrides. `null` means delete inherited var from child env. */
  env?: Record<string, string | null>;
  /** F118: Invocation context for diagnostic enrichment of __cliTimeout */
  invocationId?: string;
  /** F118: CLI session ID for diagnostic enrichment of __cliTimeout */
  cliSessionId?: string;
  /** F118 Phase B: Liveness probe config (undefined = disabled) */
  livenessProbe?: {
    sampleIntervalMs?: number;
    softWarningMs?: number;
    stallWarningMs?: number;
    boundedExtensionFactor?: number;
    /** #774: Auto-kill on idle-silent suspected_stall instead of waiting for full timeout */
    stallAutoKill?: boolean;
  };
  /** F118 Phase B: Provider-scoped raw archive path for diagnostic enrichment */
  rawArchivePath?: string;
  /**
   * Issue #116: Provider signals CLI semantic completion (e.g. turn.completed).
   * When aborted, spawnCli skips `await exitPromise` — decouples done from process exit.
   */
  semanticCompletionSignal?: AbortSignal;
}

/**
 * A transformer function that converts a raw CLI JSON event
 * into zero or more AgentMessages.
 *
 * Returns null to skip the event (e.g., system hooks, turn.started).
 */
export type CliTransformer = (event: unknown, catId: CatId) => AgentMessage | AgentMessage[] | null;

/**
 * Interface for child process (for dependency injection in tests)
 */
export interface ChildProcessLike {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Factory function type for spawning processes (for dependency injection)
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => ChildProcessLike;
