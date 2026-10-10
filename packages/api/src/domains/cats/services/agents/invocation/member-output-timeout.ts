/**
 * F117 KD-22 (Phase J, J4): each dispatched member has exactly one timeout — no real output within
 * `CLI_TIMEOUT_MS` (0 = never). Only output the model produced restarts it; heartbeats, status and
 * diagnostics do not (F149). A member whose process is still using CPU gets more time, but never
 * more than 2 × `CLI_TIMEOUT_MS` since its last output. When it fires, the owner stops the member
 * the way Stop does, with reason {@link MEMBER_TIMEOUT_REASON}.
 */
import type { ProcessActivity } from '../../../../../utils/process-activity-registry.js';
import type { AgentMessage, TimeoutDiagnostics } from '../../types.js';

/** The abort reason a member stopped by its output timeout carries (Stop carries `user_cancel`). */
export const MEMBER_TIMEOUT_REASON = 'timeout';

/** The process behind a member when its timer fires; `absent` when there is no process to probe. */
export type MemberProcessActivity = ProcessActivity | 'absent';

/** Raised by the member's own invocation when its timer fires, before the member is stopped. */
export interface MemberTimeoutEvent {
  /** The Queue execution that armed the timer (the invocation's parent execution id). */
  readonly executionId: string;
  readonly diagnostics: TimeoutDiagnostics;
}

/** Stop one member of a Queue execution with reason `timeout`; false when its slot moved on. */
export type MemberTimeoutStop = (catId: string, executionId: string) => boolean;

/**
 * The Queue side of the timeout: stop the member the way Stop does, but only while its slot still
 * runs the execution that armed the timer, so a timer left over from an earlier execution never
 * stops the one that took the slot after it. Reading the slot and cancelling it is one synchronous
 * step. The execution then winds itself down: the route commits the response, the Queue frees the
 * slot, and nothing is broadcast as a user Stop.
 */
export function createMemberTimeoutStop(input: {
  readonly invocationTracker: {
    getExecutionId(threadId: string, catId: string): string | undefined;
    cancel(threadId: string, catId: string, requestUserId?: string, abortReason?: string): { cancelled: boolean };
  };
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly log: { info(obj: Record<string, unknown>, msg: string): void };
}): MemberTimeoutStop {
  const { invocationTracker, threadId, ownerUserId, log } = input;
  return (catId, executionId) => {
    const current = invocationTracker.getExecutionId(threadId, catId);
    if (current !== executionId) {
      log.info(
        { threadId, catId, executionId, current: current ?? null },
        '[member-timeout] the slot no longer runs the execution that timed out; leaving it alone',
      );
      return false;
    }
    return invocationTracker.cancel(threadId, catId, ownerUserId, MEMBER_TIMEOUT_REASON).cancelled;
  };
}

/** The failure text a timed-out member's response carries. */
export function memberTimeoutErrorText(diagnostics: Pick<TimeoutDiagnostics, 'silenceDurationMs'>): string {
  const seconds = Math.max(1, Math.round(diagnostics.silenceDurationMs / 1000));
  const silence = seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
  return `响应超时：${silence}没有任何输出，已停止。`;
}

/** Output the model produced: text, tool calls and results, thinking and rich blocks. */
export function isMemberOutput(message: Pick<AgentMessage, 'type' | 'content'>): boolean {
  if (message.type === 'text' || message.type === 'tool_use' || message.type === 'tool_result') return true;
  if (message.type !== 'system_info' || !message.content) return false;
  try {
    const payload = JSON.parse(message.content) as { type?: unknown } | null;
    return payload?.type === 'thinking' || payload?.type === 'rich_block';
  } catch {
    return false;
  }
}

export interface MemberOutputTimeoutOptions {
  /** `CLI_TIMEOUT_MS`; 0 disables the timeout. */
  readonly timeoutMs: number;
  /** Read when the timer fires; only `busy` defers it. */
  readonly probeProcess: () => MemberProcessActivity;
  /** Called at most once, before the member is stopped, so the diagnostics outlive the abort. */
  readonly onTimeout: (diagnostics: TimeoutDiagnostics) => void;
  readonly invocationId?: string;
  readonly now?: () => number;
}

export class MemberOutputTimeout {
  readonly #options: MemberOutputTimeoutOptions;
  readonly #now: () => number;
  #lastOutputAt: number;
  #firstOutputAt: number | undefined;
  #lastOutputType: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #finished = false;

  constructor(options: MemberOutputTimeoutOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lastOutputAt = this.#now();
    if (options.timeoutMs > 0) this.#arm(options.timeoutMs);
  }

  /** Restart the clock if this message is member output. */
  observe(message: Pick<AgentMessage, 'type' | 'content'>): void {
    if (this.#finished || this.#options.timeoutMs <= 0 || !isMemberOutput(message)) return;
    const at = this.#now();
    this.#firstOutputAt ??= at;
    this.#lastOutputAt = at;
    this.#lastOutputType = message.type;
    this.#arm(this.#options.timeoutMs);
  }

  close(): void {
    this.#finished = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(delayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#expire(), delayMs);
    this.#timer.unref?.();
  }

  #expire(): void {
    if (this.#finished) return;
    const { timeoutMs } = this.#options;
    const silenceMs = this.#now() - this.#lastOutputAt;
    // Timer scheduling and the sampled clock can straddle the deadline. The
    // measured silence, rather than arrival of the callback, authorizes Stop.
    if (silenceMs < timeoutMs) {
      this.#arm(timeoutMs - silenceMs);
      return;
    }
    const activity = this.#options.probeProcess();
    const cap = 2 * timeoutMs;
    if (activity === 'busy' && silenceMs < cap) {
      this.#arm(Math.min(timeoutMs, cap - silenceMs));
      return;
    }
    this.close();
    this.#options.onTimeout({
      silenceDurationMs: silenceMs,
      processAlive: activity !== 'dead',
      ...(this.#lastOutputType ? { lastEventType: this.#lastOutputType } : {}),
      ...(this.#firstOutputAt !== undefined
        ? { firstEventAt: this.#firstOutputAt, lastEventAt: this.#lastOutputAt }
        : {}),
      ...(this.#options.invocationId ? { invocationId: this.#options.invocationId } : {}),
    });
  }
}
