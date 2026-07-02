/**
 * WriteLimitedToolInvoker — Enforces a hard physical budget of write-actions
 * per autonomy turn for Invaluable P2P peer nodes.
 *
 * Topology: transient/derived tool-layer guard; not a Link-backed identity.
 * Each peer's autonomy loop creates a fresh invoker per turn. Nested invokers
 * (e.g. for sub-tool-calls) propagate consumption back to the root parent.
 */

import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('invaluable-write-limiter');

export class WriteLimitedToolInvoker {
  private readonly budget: number;
  private consumed: number;
  private readonly parent: WriteLimitedToolInvoker | null;

  constructor(budget = 3, parent: WriteLimitedToolInvoker | null = null) {
    this.budget = budget;
    this.consumed = 0;
    this.parent = parent;
  }

  get remaining(): number {
    if (this.parent) return this.parent.remaining;
    return Math.max(0, this.budget - this.consumed);
  }

  get isExhausted(): boolean {
    return this.remaining <= 0;
  }

  /**
   * Consumes one write-action from the budget. Throws if exhausted.
   * Propagates to parent invoker if nested.
   */
  consumeWrite(): void {
    if (this.parent) {
      this.parent.consumeWrite();
      return;
    }
    if (this.consumed >= this.budget) {
      throw new WriteBudgetExhaustedError(this.budget);
    }
    this.consumed++;
    log.debug(`Write budget: ${this.remaining}/${this.budget} remaining`);
  }

  /**
   * Resets the budget for a new turn. Only effective on root invokers.
   */
  reset(): void {
    if (this.parent) {
      this.parent.reset();
    } else {
      this.consumed = 0;
    }
  }

  /**
   * Invokes a tool action, consuming a write slot if isWrite is true.
   * Read-only actions pass through without budget impact.
   */
  async invoke<T>(
    actionName: string,
    actionFn: (meta: ToolInvocationMeta) => Promise<T> | T,
    isWrite = false,
  ): Promise<T> {
    if (isWrite) {
      this.consumeWrite();
    }
    const meta: ToolInvocationMeta = {
      toolName: actionName,
      remainingBudget: this.remaining,
      isWriteAction: isWrite,
    };
    return actionFn(meta);
  }

  /**
   * Creates a child invoker that shares the parent's budget.
   */
  fork(): WriteLimitedToolInvoker {
    return new WriteLimitedToolInvoker(this.budget, this);
  }
}

export class WriteBudgetExhaustedError extends Error {
  constructor(budget: number) {
    super(`Write budget exhausted. Limit is ${budget} write-actions per turn.`);
    this.name = 'WriteBudgetExhaustedError';
  }
}

export interface ToolInvocationMeta {
  toolName: string;
  remainingBudget: number;
  isWriteAction: boolean;
}
