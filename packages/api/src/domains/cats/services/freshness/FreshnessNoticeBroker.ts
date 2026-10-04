import type { CatId } from '@cat-cafe/shared';
import { freshnessProviderNotice } from '../../../../infrastructure/telemetry/instruments.js';
import type {
  FreshnessAttentionEvent,
  ProviderNativeFreshnessCarrier,
  ProviderNativeFreshnessDeliverySemantics,
  ProviderNativeFreshnessMissReason,
  ProviderNativeFreshnessProvider,
  ProviderNativeFreshnessToolSurface,
  ProviderProtocolItemObservedEvent,
} from './FreshnessAttentionEventLog.js';
import type { UnseenScanResult } from './FreshnessNoticeService.js';

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

export type PreparedIdleFreshnessNotice = Omit<PreparedFreshnessNotice, 'expectedTurnId' | 'boundary'> & {
  boundary: { threadId: string; toolSurface: ProviderNativeFreshnessToolSurface };
};
type PreparedProviderNotice = PreparedFreshnessNotice | PreparedIdleFreshnessNotice;
export interface IdleFreshnessController {
  prepare(): Promise<PreparedIdleFreshnessNotice | null>;
  commitDelivered(notice: PreparedIdleFreshnessNotice, result: { acceptedTurnId: string }): Promise<void>;
  defer(notice: PreparedIdleFreshnessNotice): void;
  markMissed(notice: PreparedIdleFreshnessNotice, reason: ProviderNativeFreshnessMissReason): Promise<void>;
}

export interface ActiveInvocationFreshnessController {
  readonly idle?: IdleFreshnessController;
  prepare(boundary: ProviderNativeSafeBoundary): Promise<PreparedFreshnessNotice | null>;
  commitDelivered(notice: PreparedFreshnessNotice, result: { acceptedTurnId: string }): Promise<void>;
  markMissed(notice: PreparedFreshnessNotice, reason: ProviderNativeFreshnessMissReason): Promise<void>;
  markTurnCompleted(turnId: string): Promise<void>;
  observeProtocolItem?(
    observation: Pick<
      ProviderProtocolItemObservedEvent,
      'toolSurface' | 'itemType' | 'status' | 'classification' | 'boundedUnknownSample'
    >,
  ): Promise<void>;
}

interface FreshnessNoticeBrokerDeps {
  context: { invocationId: string; threadId: string; catId: CatId };
  checkUnseen: () => Promise<UnseenScanResult | null>;
  appendEvent: (event: FreshnessAttentionEvent) => Promise<void>;
  now?: () => number;
}

export function createContentFreeFreshnessNotice(input: { threadId: string; unseenCount: number }): string {
  return (
    `📬 freshness notice：当前 thread 有 ${input.unseenCount} 条新消息。` +
    `请在自然工具断点调用 cat_cafe_get_thread_context({ threadId: "${input.threadId}", readIntent: "unread", responseMode: "full" }) ` +
    '无过滤精确读取；本提醒不含消息正文。'
  );
}

export class FreshnessNoticeBroker {
  private inFlight: PreparedProviderNotice | null = null;
  private lastAttemptedFrontier: string | null = null;
  private readonly attemptedNoticeDedupKeys = new Set<string>();
  private sequence = 0;
  private readonly persistedUnknownSamples = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: FreshnessNoticeBrokerDeps) {
    this.now = deps.now ?? Date.now;
  }

  prepare(input: PrepareProviderNativeNoticeInput): Promise<PreparedFreshnessNotice | null>;
  prepare(input: Omit<PrepareProviderNativeNoticeInput, 'turnId'>): Promise<PreparedIdleFreshnessNotice | null>;
  async prepare(
    input: Omit<PrepareProviderNativeNoticeInput, 'turnId'> & { turnId?: string },
  ): Promise<PreparedProviderNotice | null> {
    if (this.inFlight) return null;
    const unseen = await this.deps.checkUnseen();
    if (!unseen || 'kind' in unseen || unseen.count === 0) return null;
    if (unseen.noticeDedupKey !== undefined) {
      if (this.attemptedNoticeDedupKeys.has(unseen.noticeDedupKey)) return null;
    } else if (this.lastAttemptedFrontier && unseen.maxMessageId <= this.lastAttemptedFrontier) {
      return null;
    }

    const noticeId = `provider-notice-${this.deps.context.invocationId}-${this.now()}-${++this.sequence}`;
    const correlationMessageIds =
      unseen.correlationMessageIds === undefined ? [unseen.maxMessageId] : [...new Set(unseen.correlationMessageIds)];
    const prepared: PreparedProviderNotice = {
      noticeId,
      frontier: unseen.maxMessageId,
      noticeDedupKey: unseen.noticeDedupKey,
      correlationMessageIds,
      ...(input.turnId ? { expectedTurnId: input.turnId } : {}),
      text: createContentFreeFreshnessNotice({ threadId: this.deps.context.threadId, unseenCount: unseen.count }),
      boundary: {
        threadId: this.deps.context.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        toolSurface: input.toolSurface,
      },
      provider: input.provider,
      carrier: input.carrier,
      deliverySemantics: input.deliverySemantics,
    };
    this.inFlight = prepared;
    const base = this.eventBase(prepared);
    try {
      await this.deps.appendEvent({ kind: 'provider_notice_opportunity', ...base });
      freshnessProviderNotice.add(1, this.noticeMetricAttributes(prepared, 'opportunity'));
      await this.deps.appendEvent({ kind: 'provider_notice_prepared', ...base });
    } catch (error) {
      this.inFlight = null;
      throw error;
    }
    return prepared;
  }

  async commitDelivered(notice: PreparedProviderNotice, result: { acceptedTurnId: string }): Promise<void> {
    if (!this.matchesInFlight(notice)) return;
    if (!result.acceptedTurnId || ('expectedTurnId' in notice && result.acceptedTurnId !== notice.expectedTurnId)) {
      await this.markMissed(notice, 'turn_mismatch');
      return;
    }
    this.recordAttempt(notice);
    this.inFlight = null;
    await this.deps.appendEvent({
      kind: 'provider_notice_delivered',
      ...this.eventBase(notice),
      acceptedTurnId: result.acceptedTurnId,
    });
    freshnessProviderNotice.add(1, this.noticeMetricAttributes(notice, 'delivered'));
  }

  defer(notice: PreparedIdleFreshnessNotice): void {
    if (this.matchesInFlight(notice)) this.inFlight = null;
  }

  async markMissed(notice: PreparedProviderNotice, reason: ProviderNativeFreshnessMissReason): Promise<void> {
    if (!this.matchesInFlight(notice)) return;
    await this.deps.appendEvent({ kind: 'provider_notice_missed', ...this.eventBase(notice), missReason: reason });
    freshnessProviderNotice.add(1, { ...this.noticeMetricAttributes(notice, 'missed'), miss_reason: reason });
    this.recordAttempt(notice);
    this.inFlight = null;
  }

  async observeProtocolItem(
    capability: Pick<ProviderProtocolItemObservedEvent, 'provider' | 'carrier' | 'deliverySemantics'>,
    observation: Pick<
      ProviderProtocolItemObservedEvent,
      'toolSurface' | 'itemType' | 'status' | 'classification' | 'boundedUnknownSample'
    >,
  ): Promise<void> {
    const sample = observation.boundedUnknownSample;
    const shouldPersistSample =
      sample !== undefined && (this.persistedUnknownSamples.has(sample) || this.persistedUnknownSamples.size < 8);
    if (sample !== undefined && shouldPersistSample) this.persistedUnknownSamples.add(sample);
    await this.deps.appendEvent({
      kind: 'provider_protocol_item_observed',
      threadId: this.deps.context.threadId,
      catId: this.deps.context.catId,
      invocationId: this.deps.context.invocationId,
      timestamp: this.now(),
      ...capability,
      toolSurface: observation.toolSurface,
      itemType: observation.itemType,
      status: observation.status,
      classification: observation.classification,
      ...(shouldPersistSample && sample !== undefined ? { boundedUnknownSample: sample.slice(0, 64) } : {}),
    });
  }

  private recordAttempt(notice: PreparedProviderNotice): void {
    this.lastAttemptedFrontier = notice.frontier;
    if (notice.noticeDedupKey !== undefined) {
      this.attemptedNoticeDedupKeys.add(notice.noticeDedupKey);
    }
  }

  private matchesInFlight(notice: PreparedProviderNotice): boolean {
    return this.inFlight?.noticeId === notice.noticeId;
  }

  private eventBase(notice: PreparedProviderNotice) {
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
      ...('expectedTurnId' in notice
        ? { expectedTurnId: notice.expectedTurnId }
        : { boundaryKind: 'idle_start' as const }),
    } as const;
  }

  private noticeMetricAttributes(notice: PreparedProviderNotice, outcome: 'opportunity' | 'delivered' | 'missed') {
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
    idle: {
      prepare: () => broker.prepare({ ...capability, deliverySemantics: 'queued_internal_turn', toolSurface: 'other' }),
      commitDelivered: (notice, result) => broker.commitDelivered(notice, result),
      defer: (notice) => broker.defer(notice),
      markMissed: (notice, reason) => broker.markMissed(notice, reason),
    },
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
    observeProtocolItem: (observation) => broker.observeProtocolItem(capability, observation),
  };
}
