import type { CatId } from '@cat-cafe/shared';
import { freshnessProviderNotice } from '../../../../infrastructure/telemetry/instruments.js';
import type {
  FreshnessAttentionEvent,
  ProviderNativeFreshnessCarrier,
  ProviderNativeFreshnessDeliverySemantics,
  ProviderNativeFreshnessMissReason,
  ProviderNativeFreshnessProvider,
  ProviderNativeFreshnessToolSurface,
} from './FreshnessAttentionEventLog.js';
import type { UnseenResult } from './FreshnessNoticeService.js';

export interface ProviderNativeSafeBoundary {
  threadId: string;
  turnId: string;
  toolSurface: ProviderNativeFreshnessToolSurface;
}

export interface PrepareProviderNativeNoticeInput {
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  toolSurface: ProviderNativeFreshnessToolSurface;
  turnId: string;
}

export interface PreparedFreshnessNotice {
  noticeId: string;
  frontier: string;
  noticeDedupKey?: string;
  correlationMessageIds: string[];
  expectedTurnId: string;
  text: string;
  boundary: ProviderNativeSafeBoundary;
  provider: ProviderNativeFreshnessProvider;
  carrier: ProviderNativeFreshnessCarrier;
  deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
}

export interface ActiveInvocationFreshnessController {
  prepare(boundary: ProviderNativeSafeBoundary): Promise<PreparedFreshnessNotice | null>;
  commitDelivered(notice: PreparedFreshnessNotice, result: { acceptedTurnId: string }): Promise<void>;
  markMissed(notice: PreparedFreshnessNotice, reason: ProviderNativeFreshnessMissReason): Promise<void>;
  markTurnCompleted(turnId: string): Promise<void>;
}

interface FreshnessNoticeBrokerDeps {
  context: { invocationId: string; threadId: string; catId: CatId };
  checkUnseen: () => Promise<UnseenResult | null>;
  appendEvent: (event: FreshnessAttentionEvent) => Promise<void>;
  now?: () => number;
}

export function createContentFreeFreshnessNotice(input: { threadId: string; unseenCount: number }): string {
  return (
    `📬 freshness notice：当前 thread 有 ${input.unseenCount} 条新消息。` +
    '请在自然工具断点调用无 filter 的 list_recent 精确读取；本提醒不含消息正文。'
  );
}

export class FreshnessNoticeBroker {
  private inFlight: PreparedFreshnessNotice | null = null;
  private lastAttemptedFrontier: string | null = null;
  private readonly attemptedNoticeDedupKeys = new Set<string>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(private readonly deps: FreshnessNoticeBrokerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async prepare(input: PrepareProviderNativeNoticeInput): Promise<PreparedFreshnessNotice | null> {
    if (this.inFlight) return null;
    const unseen = await this.deps.checkUnseen();
    if (!unseen || unseen.count === 0) return null;
    if (unseen.noticeDedupKey !== undefined) {
      if (this.attemptedNoticeDedupKeys.has(unseen.noticeDedupKey)) return null;
    } else if (this.lastAttemptedFrontier && unseen.maxMessageId <= this.lastAttemptedFrontier) {
      return null;
    }

    const noticeId = `provider-notice-${this.deps.context.invocationId}-${this.now()}-${++this.sequence}`;
    const correlationMessageIds =
      unseen.correlationMessageIds === undefined ? [unseen.maxMessageId] : [...new Set(unseen.correlationMessageIds)];
    const base = {
      threadId: this.deps.context.threadId,
      catId: this.deps.context.catId,
      invocationId: this.deps.context.invocationId,
      timestamp: this.now(),
      noticeId,
      frontier: unseen.maxMessageId,
      correlationMessageIds,
      provider: input.provider,
      carrier: input.carrier,
      deliverySemantics: input.deliverySemantics,
      toolSurface: input.toolSurface,
      expectedTurnId: input.turnId,
    } as const;

    await this.deps.appendEvent({ kind: 'provider_notice_opportunity', ...base });
    freshnessProviderNotice.add(1, this.metricAttributes(input, 'opportunity'));

    const prepared: PreparedFreshnessNotice = {
      noticeId,
      frontier: unseen.maxMessageId,
      noticeDedupKey: unseen.noticeDedupKey,
      correlationMessageIds,
      expectedTurnId: input.turnId,
      text: createContentFreeFreshnessNotice({ threadId: this.deps.context.threadId, unseenCount: unseen.count }),
      boundary: {
        threadId: this.deps.context.threadId,
        turnId: input.turnId,
        toolSurface: input.toolSurface,
      },
      provider: input.provider,
      carrier: input.carrier,
      deliverySemantics: input.deliverySemantics,
    };
    this.inFlight = prepared;
    await this.deps.appendEvent({ kind: 'provider_notice_prepared', ...base });
    return prepared;
  }

  async commitDelivered(notice: PreparedFreshnessNotice, result: { acceptedTurnId: string }): Promise<void> {
    if (!this.matchesInFlight(notice)) return;
    if (result.acceptedTurnId !== notice.expectedTurnId) {
      await this.markMissed(notice, 'turn_mismatch');
      return;
    }
    await this.deps.appendEvent({
      kind: 'provider_notice_delivered',
      ...this.eventBase(notice),
      acceptedTurnId: result.acceptedTurnId,
    });
    freshnessProviderNotice.add(1, this.noticeMetricAttributes(notice, 'delivered'));
    this.recordAttempt(notice);
    this.inFlight = null;
  }

  async markMissed(notice: PreparedFreshnessNotice, reason: ProviderNativeFreshnessMissReason): Promise<void> {
    if (!this.matchesInFlight(notice)) return;
    await this.deps.appendEvent({ kind: 'provider_notice_missed', ...this.eventBase(notice), missReason: reason });
    freshnessProviderNotice.add(1, { ...this.noticeMetricAttributes(notice, 'missed'), miss_reason: reason });
    this.recordAttempt(notice);
    this.inFlight = null;
  }

  private recordAttempt(notice: PreparedFreshnessNotice): void {
    this.lastAttemptedFrontier = notice.frontier;
    if (notice.noticeDedupKey !== undefined) {
      this.attemptedNoticeDedupKeys.add(notice.noticeDedupKey);
    }
  }

  private matchesInFlight(notice: PreparedFreshnessNotice): boolean {
    return this.inFlight?.noticeId === notice.noticeId;
  }

  private eventBase(notice: PreparedFreshnessNotice) {
    return {
      threadId: this.deps.context.threadId,
      catId: this.deps.context.catId,
      invocationId: this.deps.context.invocationId,
      timestamp: this.now(),
      noticeId: notice.noticeId,
      frontier: notice.frontier,
      correlationMessageIds: notice.correlationMessageIds,
      provider: notice.provider,
      carrier: notice.carrier,
      deliverySemantics: notice.deliverySemantics,
      toolSurface: notice.boundary.toolSurface,
      expectedTurnId: notice.expectedTurnId,
    } as const;
  }

  private metricAttributes(input: PrepareProviderNativeNoticeInput, outcome: 'opportunity') {
    return {
      provider: input.provider,
      carrier: input.carrier,
      delivery_semantics: input.deliverySemantics,
      tool_surface: input.toolSurface,
      outcome,
    };
  }

  private noticeMetricAttributes(notice: PreparedFreshnessNotice, outcome: 'delivered' | 'missed') {
    return {
      provider: notice.provider,
      carrier: notice.carrier,
      delivery_semantics: notice.deliverySemantics,
      tool_surface: notice.boundary.toolSurface,
      outcome,
    };
  }
}

export function bindFreshnessNoticeBroker(
  broker: FreshnessNoticeBroker,
  capability: {
    provider: ProviderNativeFreshnessProvider;
    carrier: ProviderNativeFreshnessCarrier;
    deliverySemantics: ProviderNativeFreshnessDeliverySemantics;
  },
): ActiveInvocationFreshnessController {
  return {
    prepare: (boundary) =>
      broker.prepare({
        ...capability,
        toolSurface: boundary.toolSurface,
        turnId: boundary.turnId,
      }),
    commitDelivered: (notice, result) => broker.commitDelivered(notice, result),
    markMissed: (notice, reason) => broker.markMissed(notice, reason),
    markTurnCompleted: async (turnId) => {
      const notice = await broker.prepare({
        ...capability,
        toolSurface: 'other',
        turnId,
      });
      if (notice) await broker.markMissed(notice, 'no_safe_boundary');
    },
  };
}
