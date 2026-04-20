import type { TrajectoryStep } from '../AntigravityBridge.js';
import type { AntigravityToolExecutor } from './AntigravityToolExecutor.js';

export function resolveToolName(step: TrajectoryStep | null | undefined): string | null {
  return step?.metadata?.toolCall?.name ?? step?.toolCall?.toolName ?? null;
}

export class ExecutorRegistry {
  private readonly executors = new Map<string, AntigravityToolExecutor>();

  register(executor: AntigravityToolExecutor): void {
    if (this.executors.has(executor.toolName)) {
      throw new Error(`Executor for tool "${executor.toolName}" already registered`);
    }
    this.executors.set(executor.toolName, executor);
  }

  resolve(step: TrajectoryStep | null | undefined): AntigravityToolExecutor | null {
    const toolName = resolveToolName(step);
    if (!toolName) return null;
    return this.executors.get(toolName) ?? null;
  }

  size(): number {
    return this.executors.size;
  }
}
