import type { LiveInboxScope } from '../inbox/live-inbox-contract.js';
import type { LiveRecoveryReader } from '../recovery/LiveRecoveryReader.js';
import type { LiveRecoveryCursor } from '../recovery/live-recovery-contract.js';
import { whileNotAborted } from './live-controlled-context.js';

export type LiveRecoverySnapshot = Awaited<ReturnType<LiveRecoveryReader['read']>>;

export interface LiveRecoveryPayload {
  text: string;
  sourceRefs: readonly string[];
  snapshot: LiveRecoverySnapshot;
  signal: AbortSignal;
}

interface LiveRecoveryHostOptions {
  scope: LiveInboxScope;
  reader: Pick<LiveRecoveryReader, 'read'>;
  deliver(payload: LiveRecoveryPayload): Promise<'accepted' | 'busy'>;
  validate(snapshot: LiveRecoverySnapshot, signal: AbortSignal): Promise<boolean>;
  canDeliver?(): boolean;
  wakeNative?(): void;
}

function payloadOf(snapshot: LiveRecoverySnapshot, signal: AbortSignal): LiveRecoveryPayload {
  const sourceRefs = [
    ...snapshot.tasks.items.map((task) => `task:${task.taskId}`),
    ...snapshot.decisions.items.map((item) => `${item.approvalCardRef.threadId}#${item.approvalCardRef.messageId}`),
    ...snapshot.inbox.items.map((item) => `${item.threadId}#${item.messageId}`),
  ];
  if (!sourceRefs.length) sourceRefs.push(`thread:${snapshot.scope.threadId}`);
  const text = JSON.stringify({
    coverage: snapshot.coverage,
    authority: snapshot.authority,
    retention: snapshot.retention,
    providerWindow: snapshot.providerWindow,
    continuity: snapshot.continuity,
    tasks: snapshot.tasks,
    summaries: snapshot.summaries,
    decisions: snapshot.decisions,
    inbox: snapshot.inbox,
  });
  return { text, sourceRefs, snapshot, signal };
}

function withinContextBound(payload: LiveRecoveryPayload): boolean {
  return (
    payload.text.length <= 8_000 &&
    payload.sourceRefs.length >= 1 &&
    payload.sourceRefs.length <= 32 &&
    payload.sourceRefs.every(
      (ref) =>
        ref.length > 0 &&
        ref.length <= 512 &&
        ![...ref].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  );
}

/** One source-backed page per actual user/work ticket; a generated idle turn never pages itself. */
export class LiveRecoveryHost {
  private controller = new AbortController();
  private cursor?: LiveRecoveryCursor;
  private pending = true;
  private running = false;
  private closed = false;

  constructor(private readonly options: LiveRecoveryHostOptions) {}

  hasPendingWake(): boolean {
    return !this.closed && this.pending && (this.options.canDeliver?.() ?? true);
  }

  onUserTurn(): void {
    if (this.closed) return;
    this.pending = true;
    this.options.wakeNative?.();
  }

  signalSourceChange(): void {
    if (this.closed) return;
    this.controller.abort('source_changed');
    this.controller = new AbortController();
    this.cursor = undefined;
    this.onUserTurn();
  }

  cancel(reason: string): void {
    if (this.closed) return;
    this.controller.abort(reason);
    this.controller = new AbortController();
    this.pending = false;
  }

  async atBoundary(): Promise<'accepted' | 'busy' | 'cancelled' | 'unavailable' | 'idle'> {
    if (!this.hasPendingWake()) return 'idle';
    if (this.running) return 'busy';
    this.pending = false;
    this.running = true;
    const controller = this.controller;
    const cursor = this.cursor;
    try {
      for (const pageSize of [8, 4, 2, 1]) {
        const snapshot = await whileNotAborted(
          controller.signal,
          this.options.reader.read(this.options.scope, {
            signal: controller.signal,
            pageSize,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (controller.signal.aborted) return 'cancelled';
        const payload = payloadOf(snapshot, controller.signal);
        if (!withinContextBound(payload)) continue;
        if (!(await this.options.validate(snapshot, controller.signal))) return 'unavailable';
        const outcome = await whileNotAborted(controller.signal, this.options.deliver(payload));
        if (outcome !== 'accepted') return 'busy';
        if (controller.signal.aborted || !(await this.options.validate(snapshot, controller.signal)))
          return 'cancelled';
        this.cursor = snapshot.nextCursor;
        return 'accepted';
      }
      return 'unavailable';
    } catch (error) {
      if (controller.signal.aborted) return 'cancelled';
      throw error;
    } finally {
      this.running = false;
      if (this.pending && !this.closed) this.options.wakeNative?.();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = false;
    this.controller.abort('closed');
  }
}
