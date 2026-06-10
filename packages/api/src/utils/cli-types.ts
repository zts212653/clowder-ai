/**
 * CLI Parser Types
 * CLI 子进程解析器的共享类型定义
 */

import type { Readable, Writable } from 'node:stream';
import type { CatId } from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import type { AgentMessage } from '../domains/cats/services/types.js';

/**
 * Options for spawning a CLI process
 */
export interface CliSpawnOptions {
  /** The CLI command to execute (e.g., 'claude', 'codex') */
  command: string;
  /** Arguments to pass to the CLI */
  args: readonly string[];
  /** stdout parser mode. Defaults to NDJSON for existing CLI providers. */
  outputMode?: 'ndjson' | 'plainText';
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
    minCpuGrowthMs?: number;
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
  /** F153 Phase B: Parent OTel span for creating CLI session child span */
  parentSpan?: Span;
  /**
   * Incident 2026-05-29 (cross-thread-context-contamination): prompt 正文经 stdin
   * 传入子进程，而非 argv 位置参数。防止 `ps -o command=` / /proc/<pid>/cmdline
   * 跨进程泄露完整对话历史（含跨 thread/猫/用户内容）。设置后 spawnCli 把
   * stdio[0] 设为 'pipe' 并将此内容写入 child.stdin。
   */
  stdinInput?: string;
  /**
   * F212 Phase F (AC-F1/F3 testability per 砚砚 R1 P1-1): test injection point for the
   * structured-log writes (`'CLI abnormal exit'` + `'CLI stderr (LOG_CLI_STDERR=1)'`).
   * Production passes nothing → falls back to the module logger. Tests pass a stub so they
   * can assert the actual log payload (invocationId presence, stderrEmpty flag, etc.) —
   * without this the AC-F6 assertions only cover `cliDiagnostics.publicHint`, leaving the
   * core backend-log contract untestable.
   */
  diagnosticLogger?: { error: (payload: object, msg: string) => void };
  /**
   * F212 Phase G: NDJSON providers need successful-exit stderr evidence for
   * silent_completion diagnostics. This callback reports sanitized stderr
   * summary without yielding an extra stream event that would perturb provider
   * event counts.
   */
  onSuccessfulExitStderr?: (summary: { stderrPresent: boolean; stderrExcerpt?: string }) => void;
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
  /** Incident 2026-05-29: stdin pipe for passing prompt off the command line. */
  readonly stdin: Writable | null;
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
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
  },
) => ChildProcessLike;
