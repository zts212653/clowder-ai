import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderNativeFreshnessToolSurface } from '../../freshness/FreshnessAttentionEventLog.js';
import type {
  ActiveInvocationFreshnessController,
  PreparedFreshnessNotice,
} from '../../freshness/FreshnessNoticeBroker.js';

/** This queue holds content-free notices only. Ordinary messages stay with F039. */
export class ClaudeSdkInput implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiter?: (result: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(text: string, sessionId: string, uuid = randomUUID()): string | null {
    if (this.closed) return null;
    const value: SDKUserMessage = {
      type: 'user',
      uuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    };
    if (this.waiter) {
      this.waiter({ value, done: false });
      this.waiter = undefined;
    } else this.values.push(value);
    return uuid;
  }
  close(): void {
    this.closed = true;
    this.values = [];
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

/** Result UUIDs confirm a local correlation, never an upstream expectedTurn guard. */
export class ClaudeSdkFreshness {
  private pending?: { notice: PreparedFreshnessNotice; uuid: string };
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private sessionId = '';
  private toolSurface: ProviderNativeFreshnessToolSurface = 'other';
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly input: ClaudeSdkInput,
    private readonly turnId: string,
    private readonly threadId: string,
    private readonly controller?: ActiveInvocationFreshnessController,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly recordInput?: (notice: PreparedFreshnessNotice, uuid: string) => Promise<void>,
  ) {}

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }
  cancel(): void {
    this.stop();
  }
  start(): void {
    if (this.closed || !this.controller) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);
    this.timer.unref();
  }
  poll(surface?: ProviderNativeFreshnessToolSurface): Promise<void> {
    if (surface) this.toolSurface = surface;
    this.inFlight = this.inFlight
      .then(async () => {
        if (this.closed || this.pending || !this.controller || !this.sessionId) return;
        const notice = await this.controller.prepare({
          threadId: this.threadId,
          turnId: this.turnId,
          toolSurface: this.toolSurface,
        });
        if (!notice) return;
        // A result/cancel may arrive while the owner is checking the unread frontier.
        if (this.closed) {
          await this.controller.markMissed(notice, 'turn_completed');
          return;
        }
        const uuid = this.input.push(notice.text, this.sessionId);
        if (uuid) {
          this.pending = { notice, uuid };
          await this.recordInput?.(notice, uuid).catch(this.onError);
        } else await this.controller.markMissed(notice, 'transport_failed');
      })
      .catch(this.onError);
    return this.inFlight;
  }
  async settle(result: Record<string, unknown>): Promise<'delivered' | 'missed' | 'unconfirmed' | 'none'> {
    this.stop();
    await this.inFlight;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || !this.controller) return 'none';
    try {
      const uuids = Array.isArray(result.user_message_uuids) ? result.user_message_uuids : [];
      if (
        uuids.includes(this.turnId) &&
        uuids.includes(pending.uuid) &&
        result.terminal_reason !== 'aborted_streaming'
      ) {
        await this.controller.commitDelivered(pending.notice, { acceptedTurnId: this.turnId });
        return 'delivered';
      }
      await this.controller.markMissed(pending.notice, 'turn_completed');
      return 'missed';
    } catch (error) {
      // An auxiliary receipt failure cannot change the authoritative SDK result.
      // Do not retry an uncertain write or manufacture delivered/missed evidence.
      this.onError(error);
      return 'unconfirmed';
    }
  }
  async close(failed: boolean): Promise<void> {
    this.stop();
    await this.inFlight;
    if (this.pending && this.controller) {
      const pending = this.pending;
      this.pending = undefined;
      await this.controller
        .markMissed(pending.notice, failed ? 'transport_failed' : 'turn_completed')
        .catch(this.onError);
    }
    await this.controller?.markTurnCompleted(this.turnId);
  }
  private stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.input.close();
  }
}
