import {
  finiteDuration,
  type NativeMessageReadProgress,
  safeNativeReadProgress,
} from './message-read-progress-native.js';
import { isReadStopReason, ReadStopError, type ReadStopReason, readStopReason } from './read-stop-diagnostics.js';

export type MessageReadStage = 'visibility' | 'source-thread' | 'source-message' | 'retrieval';
export interface MessageReadProgress {
  stage: MessageReadStage;
  state: 'pending' | 'fulfilled' | 'rejected';
  elapsedMs: number;
  native?: NativeMessageReadProgress;
  stopReason?: ReadStopReason;
}

export interface MessageSearchExecutionContext {
  signal?: AbortSignal;
  deadlineAt?: number;
  onTrace?: (trace: Record<string, unknown>) => void;
  /** Internal discovery read only; never a public argument or a candidate/body channel. */
  onReadProgress?: (progress: MessageReadProgress) => void;
}

const readStages = new Set(['visibility', 'source-thread', 'source-message', 'retrieval']);
const readStates = new Set(['pending', 'fulfilled', 'rejected']);
const duration = finiteDuration;

export function safeMessageReadProgress(value: unknown): MessageReadProgress | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const { stage, state, elapsedMs, native: rawNative, stopReason } = value as Record<string, unknown>;
    if (
      typeof stage !== 'string' ||
      !readStages.has(stage) ||
      typeof state !== 'string' ||
      !readStates.has(state) ||
      !duration(elapsedMs)
    )
      return;
    const native = safeNativeReadProgress(rawNative);
    return {
      stage: stage as MessageReadStage,
      state: state as MessageReadProgress['state'],
      elapsedMs,
      ...(state === 'rejected' && isReadStopReason(stopReason) ? { stopReason } : {}),
      ...(native ? { native } : {}),
    };
  } catch {
    return;
  }
}

/** Per-native-read observation. Closing it never cancels the caller or changes source admission. */
export class MessageReadObservation {
  private active = true;
  private current?: {
    stage: MessageReadStage;
    state: MessageReadProgress['state'];
    started: number;
    stopReason?: ReadStopReason;
  };
  private native?: { value: NonNullable<MessageReadProgress['native']>; observedAt: number };
  constructor(private readonly context: MessageSearchExecutionContext) {}

  async run<T>(stage: MessageReadStage, work: () => T | Promise<T>): Promise<T> {
    this.check();
    this.current = { stage, state: 'pending', started: performance.now() };
    this.publish();
    let value: T;
    try {
      this.check();
      value = await work();
      this.check();
      this.current.state = 'fulfilled';
    } catch (error) {
      this.current.state = 'rejected';
      this.current.stopReason = readStopReason(error, this.context.signal, 'reader_rejected');
      this.publish();
      throw error;
    }
    this.publish();
    // Optional observers cannot authorize late success or replace an existing failure.
    try {
      this.check();
    } catch (error) {
      this.current.state = 'rejected';
      this.current.stopReason = readStopReason(error, this.context.signal, 'reader_rejected');
      this.publish();
      throw error;
    }
    return value;
  }

  readonly worker = (snapshot: unknown) => {
    if (!this.active || this.current?.stage !== 'retrieval') return;
    const value = safeNativeReadProgress(snapshot);
    if (!value) return;
    this.native = { value, observedAt: performance.now() };
    this.publish();
  };

  close() {
    this.active = false;
  }
  private check() {
    if (!this.active) throw new ReadStopError('read_closed', 'Message read lifetime replaced');
    checkSearchExecution(this.context);
  }
  private publish() {
    if (!this.active || !this.current) return;
    const now = performance.now();
    try {
      this.context.onReadProgress?.({
        stage: this.current.stage,
        state: this.current.state,
        elapsedMs: now - this.current.started,
        ...(this.current.stopReason ? { stopReason: this.current.stopReason } : {}),
        ...(this.native ? { native: { ...this.native.value, observationAgeMs: now - this.native.observedAt } } : {}),
      });
    } catch {
      /* Observation never owns completion or cancellation. */
    }
  }
}

export function checkSearchExecution(context: MessageSearchExecutionContext): void {
  context.signal?.throwIfAborted();
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt)
    throw new ReadStopError('deadline_exceeded', 'Message search deadline exceeded');
}

/** Stop awaiting read-only work early; discard late results. The supplied child
 * context expires with this wait, so owned resources can be disposed immediately.
 * The original request cancellation and hard deadline always outrank a soft cutoff. */
export async function readBeforeSearchCutoff<T>(
  read: (lifetime: MessageSearchExecutionContext) => Promise<T>,
  cutoffAt: number,
  context: MessageSearchExecutionContext,
): Promise<{ completed: true; value: T } | { completed: false }> {
  checkSearchExecution(context);
  if (Date.now() >= cutoffAt) return { completed: false };
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stop = new Promise<{ completed: false }>((resolve, reject) => {
      timer = setTimeout(
        () => {
          resolve({ completed: false });
          lifetime.abort(new ReadStopError('read_cutoff', 'Message search read cutoff exceeded'));
        },
        Math.max(0, cutoffAt - Date.now()),
      );
      if (context.signal) {
        onAbort = () => {
          reject(context.signal?.reason);
          lifetime.abort(context.signal?.reason);
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const value = await Promise.race([
      Promise.resolve()
        .then(() => {
          lifetime.signal.throwIfAborted();
          return read({
            ...context,
            signal: lifetime.signal,
            deadlineAt: Math.min(cutoffAt, context.deadlineAt ?? Infinity),
          });
        })
        .then((value) => ({ completed: true as const, value })),
      stop,
    ]);
    checkSearchExecution(context);
    return value;
  } finally {
    lifetime.abort(new ReadStopError('read_closed', 'Message search read finished'));
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) context.signal?.removeEventListener('abort', onAbort);
  }
}
