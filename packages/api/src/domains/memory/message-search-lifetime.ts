export type MessageReadStage = 'visibility' | 'source-thread' | 'source-message' | 'retrieval';
export interface MessageReadProgress {
  stage: MessageReadStage;
  state: 'pending' | 'fulfilled' | 'rejected';
  elapsedMs: number;
  native?: {
    phase:
      | 'queue'
      | 'worker-startup'
      | 'database-initialization'
      | 'worker-processing'
      | 'sql-read'
      | 'embedding-load'
      | 'embedding-reprobeIfNeeded'
      | 'embedding-embed';
    outcome: 'pending' | 'fulfilled' | 'rejected';
    elapsedMs: number;
    queueMs?: number;
    observationAgeMs: number;
  };
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
const nativePhases = new Set([
  'queue',
  'worker-startup',
  'database-initialization',
  'worker-processing',
  'sql-read',
  'embedding-load',
  'embedding-reprobeIfNeeded',
  'embedding-embed',
]);
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Whitelist only the existing worker's finite operational labels and durations. */
function nativeReadProgress(value: unknown): MessageReadProgress['native'] {
  try {
    if (!value || typeof value !== 'object') return;
    const { phase, outcome, elapsedMs, queueMs, observationAgeMs } = value as Record<string, unknown>;
    if (
      typeof phase !== 'string' ||
      !nativePhases.has(phase) ||
      typeof outcome !== 'string' ||
      !readStates.has(outcome) ||
      !duration(elapsedMs)
    )
      return;
    return {
      phase: phase as NonNullable<MessageReadProgress['native']>['phase'],
      outcome: outcome as NonNullable<MessageReadProgress['native']>['outcome'],
      elapsedMs,
      ...(duration(queueMs) ? { queueMs } : {}),
      observationAgeMs: duration(observationAgeMs) ? observationAgeMs : 0,
    };
  } catch {
    return;
  }
}

export function safeMessageReadProgress(value: unknown): MessageReadProgress | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const { stage, state, elapsedMs, native: rawNative } = value as Record<string, unknown>;
    if (
      typeof stage !== 'string' ||
      !readStages.has(stage) ||
      typeof state !== 'string' ||
      !readStates.has(state) ||
      !duration(elapsedMs)
    )
      return;
    const native = nativeReadProgress(rawNative);
    return {
      stage: stage as MessageReadStage,
      state: state as MessageReadProgress['state'],
      elapsedMs,
      ...(native ? { native } : {}),
    };
  } catch {
    return;
  }
}

/** Per-native-read observation. Closing it never cancels the caller or changes source admission. */
export class MessageReadObservation {
  private active = true;
  private current?: { stage: MessageReadStage; state: MessageReadProgress['state']; started: number };
  private native?: { value: NonNullable<MessageReadProgress['native']>; observedAt: number };
  constructor(private readonly context: MessageSearchExecutionContext) {}

  async run<T>(stage: MessageReadStage, work: () => T | Promise<T>): Promise<T> {
    this.check();
    this.current = { stage, state: 'pending', started: performance.now() };
    this.publish();
    try {
      this.check();
      const value = await work();
      this.check();
      this.current.state = 'fulfilled';
      return value;
    } catch (error) {
      this.current.state = 'rejected';
      throw error;
    } finally {
      this.publish();
      // Optional observers cannot authorize late success or replace an existing failure.
      if (this.current.state === 'fulfilled') this.check();
    }
  }

  readonly worker = (snapshot: unknown) => {
    if (!this.active || this.current?.stage !== 'retrieval') return;
    const value = nativeReadProgress(snapshot);
    if (!value) return;
    this.native = { value, observedAt: performance.now() };
    this.publish();
  };

  close() {
    this.active = false;
  }
  private check() {
    if (!this.active) throw new DOMException('Message read lifetime replaced', 'AbortError');
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
    throw new DOMException('Message search deadline exceeded', 'TimeoutError');
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
          lifetime.abort(new DOMException('Message search read cutoff exceeded', 'TimeoutError'));
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
    lifetime.abort(new DOMException('Message search read finished', 'AbortError'));
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) context.signal?.removeEventListener('abort', onAbort);
  }
}
