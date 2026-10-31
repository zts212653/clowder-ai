import type { F317MeetingGrant } from '../../meeting/f317-meeting-admission.js';
import type { F317MeetingContext } from '../../meeting/f317-meeting-artifact.js';
import { startF317MeetingFeed } from '../../meeting/f317-meeting-feed.js';
import type { createF317MeetingSource, F317MeetingSubscription } from '../../meeting/f317-meeting-source.js';
import { LiveCarrierUnavailableError } from '../LiveCarrierOperationGate.js';
import { type LiveContextScope, type LiveControlledContext, whileNotAborted } from './live-controlled-context.js';

export interface LiveMeetingDependencies {
  source: ReturnType<typeof createF317MeetingSource>;
  wakeSource: Parameters<typeof startF317MeetingFeed>[0]['wakeSource'];
}

interface LiveMeetingHostOptions extends LiveMeetingDependencies {
  scope: LiveContextScope;
  grant: F317MeetingGrant;
  verify(): Promise<boolean>;
  inject(input: LiveControlledContext): Promise<'accepted'>;
  wakeNative(): void;
}

type BoundaryResult = 'accepted' | 'busy' | 'cancelled' | 'unavailable' | 'idle';
type MeetingPayload = { text: string; sourceRefs: string[]; lastCursor: number };
const MAX_BUFFERED_CHUNKS = 32;
const MAX_CONTEXT_ITEMS = 4;
const MAX_EXCERPT_CHARS = 700;

/** F195 is the source of truth; this bounded buffer is only a private, per-call view. */
export class LiveMeetingHost {
  private readonly controller = new AbortController();
  private readonly buffered = new Map<number, F317MeetingContext>();
  private subscription?: F317MeetingSubscription;
  private feed?: { close(): void };
  private delivery?: AbortController;
  private acceptedCursor = 0;
  private omittedEarlier = 0;
  private ticket = 0;
  private pendingQuestion = false;
  private userSpeaking = false;
  private running = false;
  private closed = false;

  private constructor(private readonly options: LiveMeetingHostOptions) {}

  static async attach(
    options: LiveMeetingHostOptions,
    registerPending?: (host: LiveMeetingHost) => void,
  ): Promise<LiveMeetingHost> {
    const host = new LiveMeetingHost(options);
    try {
      registerPending?.(host);
      await host.start();
      return host;
    } catch (error) {
      host.close();
      throw error;
    }
  }

  get grantId(): string {
    return this.options.grant.grantId;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isOpenFor(grant: F317MeetingGrant): boolean {
    return this.options.grant === grant && !this.closed && !grant.signal.aborted && Boolean(this.feed);
  }

  hasPendingWake(): boolean {
    return !this.closed && !this.userSpeaking && this.pendingQuestion && this.unaccepted().length > 0;
  }

  onUserSpeaking(): void {
    if (this.closed) return;
    this.userSpeaking = true;
    this.delivery?.abort('user_speaking');
  }

  onUserTurn(): void {
    if (this.closed) return;
    this.userSpeaking = false;
    this.ticket++;
    this.pendingQuestion = true;
    this.delivery?.abort('new_user_turn');
    if (this.hasPendingWake()) this.options.wakeNative();
  }

  async atBoundary(): Promise<BoundaryResult> {
    if (this.closed) return 'cancelled';
    if (this.pendingQuestion && this.unaccepted().length === 0) {
      this.pendingQuestion = false;
      return 'idle';
    }
    if (!this.hasPendingWake()) return 'idle';
    if (this.running) return 'busy';
    const payload = this.payload();
    if (!payload) return 'unavailable';
    const ticket = this.ticket;
    const delivery = new AbortController();
    this.delivery = delivery;
    this.running = true;
    this.pendingQuestion = false;
    const signal = AbortSignal.any([this.controller.signal, this.options.grant.signal, delivery.signal]);
    try {
      return await this.submit(payload, signal);
    } catch (error) {
      if (signal.aborted || this.closed) return 'cancelled';
      if (error instanceof LiveCarrierUnavailableError) return 'busy';
      throw error;
    } finally {
      this.settleBoundary(delivery, ticket, payload.lastCursor);
    }
  }

  private async submit(payload: MeetingPayload, signal: AbortSignal): Promise<BoundaryResult> {
    if (!(await this.authorize(signal))) return 'unavailable';
    await whileNotAborted(
      signal,
      this.options.inject({
        scope: this.options.scope,
        kind: 'meeting_context',
        text: payload.text,
        sourceRefs: payload.sourceRefs,
        signal,
        authorizeSource: (candidate) => this.authorize(candidate),
      }),
    );
    if (!(await this.authorize(signal))) return 'cancelled';
    this.acceptedCursor = payload.lastCursor;
    return 'accepted';
  }

  private settleBoundary(delivery: AbortController, ticket: number, lastCursor: number): void {
    if (this.delivery === delivery) this.delivery = undefined;
    this.running = false;
    if (!this.closed && ticket === this.ticket && this.acceptedCursor < lastCursor) this.pendingQuestion = true;
    if (!this.closed && ticket !== this.ticket && this.hasPendingWake()) this.options.wakeNative();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingQuestion = false;
    this.controller.abort('meeting_share_closed');
    this.delivery?.abort('meeting_share_closed');
    this.feed?.close();
    this.subscription?.close();
    this.buffered.clear();
    this.options.grant.signal.removeEventListener('abort', this.onGrantAborted);
  }

  private readonly onGrantAborted = () => this.close();

  private async start(): Promise<void> {
    const { grant } = this.options;
    const admissionSignal = AbortSignal.any([this.controller.signal, grant.signal]);
    if (!(await whileNotAborted(admissionSignal, this.authorize(admissionSignal))))
      throw new Error('meeting_share_not_admitted');
    grant.signal.addEventListener('abort', this.onGrantAborted, { once: true });
    this.subscription = this.options.source.bind(
      {
        threadId: grant.captureThreadId,
        meetingId: grant.meetingId,
        callId: grant.callId,
        generation: grant.generation,
      },
      { onContext: (item, signal) => this.onContext(item, signal) },
    );
    try {
      const opening = startF317MeetingFeed({
        threadId: grant.captureThreadId,
        subscription: this.subscription,
        wakeSource: this.options.wakeSource,
        onStopped: () => this.close(),
        onError: () => this.close(),
      });
      void opening
        .then((feed) => {
          if (this.closed) feed.close();
        })
        .catch(() => undefined);
      this.feed = await whileNotAborted(
        AbortSignal.any([this.controller.signal, grant.signal, AbortSignal.timeout(5_000)]),
        opening,
      );
      if (this.closed || grant.signal.aborted) throw new Error('meeting_share_not_admitted');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async onContext(item: F317MeetingContext, sourceSignal: AbortSignal): Promise<void> {
    const { grant } = this.options;
    if (
      sourceSignal.aborted ||
      !(await this.authorize(sourceSignal)) ||
      item.callId !== grant.callId ||
      item.generation !== grant.generation ||
      item.context.meetingId !== grant.meetingId
    ) {
      this.close();
      throw new Error('meeting_share_not_admitted');
    }
    const previous = this.buffered.get(item.chunkNum);
    if (!previous || previous.cursor < item.cursor) this.buffered.set(item.chunkNum, item);
    if (this.buffered.size > MAX_BUFFERED_CHUNKS) {
      const oldest = [...this.buffered.values()].sort((left, right) => left.cursor - right.cursor)[0];
      if (oldest) {
        this.buffered.delete(oldest.chunkNum);
        this.omittedEarlier++;
      }
    }
    if (this.hasPendingWake()) this.options.wakeNative();
  }

  private async authorize(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed || this.options.grant.signal.aborted) return false;
    if (!(await this.options.verify())) return false;
    return !signal.aborted && !this.closed && !this.options.grant.signal.aborted;
  }

  private unaccepted(): F317MeetingContext[] {
    return [...this.buffered.values()]
      .filter((item) => item.cursor > this.acceptedCursor)
      .sort((left, right) => left.cursor - right.cursor);
  }

  private payload(): MeetingPayload | null {
    const eligible = this.unaccepted();
    for (let count = Math.min(eligible.length, MAX_CONTEXT_ITEMS); count > 0; count--) {
      const selected = eligible.slice(-count);
      const sourceRefs = selected.map((item) => item.sourceRef);
      const text = JSON.stringify({
        coverage: 'recent_bounded_excerpt',
        meetingId: this.options.grant.meetingId,
        omittedEarlier: this.omittedEarlier + eligible.length - selected.length,
        items: selected.map((item) => ({
          sourceRef: item.sourceRef,
          operation: item.operation,
          context: {
            ...item.context,
            content: item.context.content.slice(0, MAX_EXCERPT_CHARS),
            truncated: item.context.content.length > MAX_EXCERPT_CHARS,
          },
        })),
      });
      const last = selected.at(-1);
      if (last && text.length <= 8_000) return { text, sourceRefs, lastCursor: last.cursor };
    }
    return null;
  }
}
