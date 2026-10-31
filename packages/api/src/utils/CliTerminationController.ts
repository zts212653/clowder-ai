import type { ChildProcessLike } from './cli-types.js';

export type CliTerminationMode = 'interrupt-first' | 'terminate-first';
export type CliTerminationStage = 'interrupt' | 'terminate' | 'kill';
export type CliTerminationState = 'running' | 'interrupt_sent' | 'terminate_sent' | 'kill_sent' | 'exited';

export interface CliTerminationGraces {
  interruptMs: number;
  terminateMs: number;
}

interface CliTerminationTransition {
  readonly signal: NodeJS.Signals;
  readonly stage: CliTerminationStage;
  readonly state: CliTerminationState;
  readonly sequence: number;
}

interface CliTerminationControllerOptions {
  readonly child: Pick<ChildProcessLike, 'kill'>;
  readonly isChildExited: () => boolean;
  readonly graces: CliTerminationGraces;
  readonly onTransition?: (transition: CliTerminationTransition) => void;
}

/**
 * Owns the monotonic CLI signal sequence.
 *
 * A request is a commit point: before it, a recovered NDJSON event may cancel a
 * pending stall; after it, repeated requests are idempotent and escalation can
 * only move forward. Child exit clears every timer and permanently closes the
 * controller so PID reuse cannot receive a late signal.
 */
export class CliTerminationController {
  private state: CliTerminationState = 'running';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly signals: NodeJS.Signals[] = [];
  private readonly committed: Promise<void>;
  private readonly completed: Promise<void>;
  private resolveCommitted!: () => void;
  private resolveCompleted!: () => void;

  constructor(private readonly options: CliTerminationControllerOptions) {
    this.committed = new Promise((resolve) => {
      this.resolveCommitted = resolve;
    });
    this.completed = new Promise((resolve) => {
      this.resolveCompleted = resolve;
    });
  }

  request(mode: CliTerminationMode): boolean {
    if (this.state !== 'running' || this.options.isChildExited()) return false;
    if (mode === 'interrupt-first') {
      this.send('SIGINT', 'interrupt', 'interrupt_sent');
      this.arm(this.options.graces.interruptMs, () => this.sendTerminate());
    } else {
      this.sendTerminate();
    }
    return true;
  }

  markExited(): void {
    if (this.state === 'exited') return;
    this.clearTimer();
    this.state = 'exited';
    this.resolveCompleted();
  }

  waitForCommit(): Promise<void> {
    return this.committed;
  }

  /** Resolves on child exit or after the final SIGKILL attempt. */
  waitForCompletion(): Promise<void> {
    return this.completed;
  }

  getState(): CliTerminationState {
    return this.state;
  }

  getSignalsSent(): readonly NodeJS.Signals[] {
    return [...this.signals];
  }

  getFinalStage(): CliTerminationStage | 'none' {
    const lastSignal = this.signals.at(-1);
    if (lastSignal === 'SIGINT') return 'interrupt';
    if (lastSignal === 'SIGTERM') return 'terminate';
    if (lastSignal === 'SIGKILL') return 'kill';
    return 'none';
  }

  private sendTerminate(): void {
    if (this.state === 'exited' || this.options.isChildExited()) {
      this.markExited();
      return;
    }
    if (this.state !== 'running' && this.state !== 'interrupt_sent') return;
    this.send('SIGTERM', 'terminate', 'terminate_sent');
    this.arm(this.options.graces.terminateMs, () => this.sendKill());
  }

  private sendKill(): void {
    if (this.state === 'exited' || this.options.isChildExited()) {
      this.markExited();
      return;
    }
    if (this.state !== 'terminate_sent') return;
    this.send('SIGKILL', 'kill', 'kill_sent');
    this.clearTimer();
  }

  private send(signal: NodeJS.Signals, stage: CliTerminationStage, nextState: CliTerminationState): void {
    if (this.state === 'exited' || this.options.isChildExited()) {
      this.markExited();
      return;
    }
    this.clearTimer();
    this.signals.push(signal);
    this.state = nextState;
    if (this.signals.length === 1) this.resolveCommitted();
    this.options.child.kill(signal);
    this.options.onTransition?.({ signal, stage, state: nextState, sequence: this.signals.length });
    if (signal === 'SIGKILL') this.resolveCompleted();
  }

  private arm(delayMs: number, callback: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(callback, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
