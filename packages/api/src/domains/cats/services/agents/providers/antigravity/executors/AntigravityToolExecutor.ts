import type { TrajectoryStep } from '../AntigravityBridge.js';

export type ExecutorResult<T> =
  | {
      status: 'success';
      output: T;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      durationMs: number;
    }
  | {
      status: 'error';
      error: string;
      stderr?: string;
      durationMs: number;
    }
  | {
      status: 'refused';
      reason: string;
    };

export interface AuditEntry {
  tool: string;
  cascadeId: string;
  stepIndex: number;
  input: unknown;
  result: ExecutorResult<unknown>;
  timestamp: Date;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void> | void;
}

export interface ExecutorContext {
  cascadeId: string;
  trajectoryId: string;
  stepIndex: number;
  cwd: string;
  audit: AuditSink;
}

export interface AntigravityToolExecutor<TInput = unknown, TOutput = unknown> {
  readonly toolName: string;
  canHandle(step: TrajectoryStep): boolean;
  execute(input: TInput, ctx: ExecutorContext): Promise<ExecutorResult<TOutput>>;
}
