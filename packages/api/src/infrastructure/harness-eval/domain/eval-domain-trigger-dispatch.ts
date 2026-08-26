import { randomUUID } from 'node:crypto';
import type { ExecuteContext, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import type { EvalCatInvocationPacket } from '../eval-cat-invocation.js';
import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';
import type {
  EvalDomainTriggerChannel,
  EvalDomainTriggerClaimResult,
  EvalDomainTriggerReceiptRef,
  IEvalDomainTriggerStore,
} from './eval-domain-trigger-store.js';
import { buildScheduledEvalInvocationMessage } from './scheduled-eval-grounding.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const CLAIM_LEASE_MS = 5 * 60 * 1_000;
const UTC_CRON_HOUR = 3;

export interface EvalDomainTriggerWindow {
  windowKey: string;
  startMs: number;
  endMs: number;
}

export interface EvalDomainThresholdEvent {
  eventId: string;
  eventSource: string;
  counter: string;
  previousValue: number;
  currentValue: number;
}

export type EvalDomainTriggerDispatchOutcome =
  | 'dispatched'
  | 'deduped'
  | 'overlap'
  | 'cooldown'
  | 'not_crossing'
  | 'rejected_policy'
  | 'delivery_unavailable'
  | 'trigger_full'
  | 'trigger_failed'
  | 'unavailable';

export interface EvalDomainTriggerDispatchResult {
  outcome: EvalDomainTriggerDispatchOutcome;
  windowKey: string;
  dedupeKey: string;
}

interface DispatchInput {
  domain: EvalDomainRegistryEntry;
  invocation: EvalCatInvocationPacket;
  channel: EvalDomainTriggerChannel;
  event?: EvalDomainThresholdEvent;
  triggerReason: string;
  store?: IEvalDomainTriggerStore;
  deliver?: ExecuteContext['deliver'];
  invokeTrigger?: ScheduleInvokeTrigger;
  defaultUserId?: string;
  nowMs?: number;
  tokenFactory?: () => string;
}

export function deriveEvalDomainTriggerWindow(frequency: string, nowMs: number): EvalDomainTriggerWindow {
  const date = new Date(nowMs);
  let periodMs: number;
  let startMs: number;
  let prefix: string;

  if (frequency === 'daily') {
    periodMs = DAY_MS;
    startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), UTC_CRON_HOUR);
    if (startMs > nowMs) startMs -= DAY_MS;
    prefix = 'daily';
  } else if (frequency === 'weekly') {
    periodMs = 7 * DAY_MS;
    const todayAtCron = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), UTC_CRON_HOUR);
    startMs = todayAtCron - date.getUTCDay() * DAY_MS;
    if (startMs > nowMs) startMs -= periodMs;
    prefix = 'weekly';
  } else {
    const match = /^every-([1-9]\d*)d$/.exec(frequency);
    if (!match) throw new Error(`unsupported eval domain frequency: ${frequency}`);
    periodMs = Number.parseInt(match[1], 10) * DAY_MS;
    startMs = Math.floor((nowMs - UTC_CRON_HOUR * HOUR_MS) / periodMs) * periodMs + UTC_CRON_HOUR * HOUR_MS;
    prefix = frequency;
  }

  return {
    windowKey: `${prefix}:${new Date(startMs).toISOString()}`,
    startMs,
    endMs: startMs + periodMs,
  };
}

function result(outcome: EvalDomainTriggerDispatchOutcome, windowKey: string, dedupeKey: string) {
  return { outcome, windowKey, dedupeKey } satisfies EvalDomainTriggerDispatchResult;
}

function mapClaimOutcome(
  outcome: Exclude<EvalDomainTriggerClaimResult['outcome'], 'claimed'>,
): 'deduped' | 'overlap' | 'cooldown' {
  return outcome;
}

export async function dispatchEvalDomainTrigger(input: DispatchInput): Promise<EvalDomainTriggerDispatchResult> {
  return new EvalDomainTriggerDispatchRun(input).execute();
}

class EvalDomainTriggerDispatchRun {
  private readonly nowMs: number;
  private readonly window: EvalDomainTriggerWindow;
  private readonly dedupeKey: string;
  private readonly token: string;
  private readonly claimed: EvalDomainTriggerReceiptRef[] = [];
  private readonly windowReceipt: EvalDomainTriggerReceiptRef;
  private eventReceipt: EvalDomainTriggerReceiptRef | undefined;
  private guardedByStore: boolean;

  constructor(private readonly input: DispatchInput) {
    this.nowMs = input.nowMs ?? Date.now();
    this.window = deriveEvalDomainTriggerWindow(input.domain.frequency, this.nowMs);
    this.dedupeKey = `eval-domain-trigger:${input.domain.domainId}:${this.window.windowKey}`;
    this.token = input.tokenFactory?.() ?? randomUUID();
    this.guardedByStore = Boolean(input.store);
    this.windowReceipt = {
      kind: 'window',
      domainId: input.domain.domainId,
      receiptId: this.window.windowKey,
      token: this.token,
    };
  }

  async execute(): Promise<EvalDomainTriggerDispatchResult> {
    if (this.input.channel === 'threshold_event') {
      const eventOutcome = await this.prepareThresholdEvent();
      if (eventOutcome) return eventOutcome;
    }

    const windowOutcome = await this.claimWindow();
    if (windowOutcome) return windowOutcome;
    if (!this.input.deliver) {
      await this.releaseClaims();
      return this.outcome('delivery_unavailable');
    }
    return this.deliverAndWake();
  }

  private async prepareThresholdEvent(): Promise<EvalDomainTriggerDispatchResult | null> {
    const policy = this.input.domain.triggerPolicy;
    const event = this.input.event;
    if (
      policy.mode !== 'threshold_or_time' ||
      !event ||
      event.eventSource !== policy.eventSource ||
      event.counter !== policy.threshold.counter
    ) {
      return this.outcome('rejected_policy');
    }
    if (!this.input.store) return this.outcome('unavailable');

    this.eventReceipt = {
      kind: 'event',
      domainId: this.input.domain.domainId,
      receiptId: event.eventId,
      token: this.token,
    };
    const claim = await this.tryClaim(this.eventReceipt);
    if (!claim) return this.outcome('unavailable');
    if (claim.outcome !== 'claimed') return this.outcome(mapClaimOutcome(claim.outcome));
    this.claimed.push(this.eventReceipt);

    const crossed =
      event.previousValue < policy.threshold.crossingAt && event.currentValue >= policy.threshold.crossingAt;
    if (crossed) return null;
    const completed = await this.tryComplete(this.eventReceipt);
    return this.outcome(completed ? 'not_crossing' : 'unavailable');
  }

  private async claimWindow(): Promise<EvalDomainTriggerDispatchResult | null> {
    if (!this.input.store) return null;
    const claim = await this.tryClaim(this.windowReceipt);
    if (!claim) {
      if (this.input.channel === 'time') {
        this.guardedByStore = false;
        return null;
      }
      await this.releaseClaims();
      return this.outcome('unavailable');
    }
    if (claim.outcome === 'claimed') {
      this.claimed.push(this.windowReceipt);
      return null;
    }
    const settled = await this.settleBlockedEvent(claim.outcome);
    return settled ? this.outcome(mapClaimOutcome(claim.outcome)) : this.outcome('unavailable');
  }

  private async settleBlockedEvent(outcome: EvalDomainTriggerClaimResult['outcome']): Promise<boolean> {
    if (this.eventReceipt && ['deduped', 'cooldown'].includes(outcome)) {
      return this.tryComplete(this.eventReceipt);
    }
    await this.releaseClaims();
    return true;
  }

  private async deliverAndWake(): Promise<EvalDomainTriggerDispatchResult> {
    try {
      const messageId = await this.deliverMessage();
      const wakeOutcome = await this.wakeCat(messageId);
      if (wakeOutcome !== 'dispatched') {
        await this.releaseClaims();
        return this.outcome(wakeOutcome);
      }
      // Delivery is idempotent on the shared dedupe key. If receipt completion fails
      // after wake, lease replay can wake again but cannot duplicate the invocation message.
      const completed = await this.completeClaims();
      return this.outcome(completed ? 'dispatched' : 'unavailable');
    } catch {
      await this.releaseClaims();
      return this.outcome('trigger_failed');
    }
  }

  private async deliverMessage(): Promise<string> {
    if (!this.input.deliver) throw new Error('scheduled eval delivery is unavailable');
    const messageId = await this.input.deliver({
      threadId: this.input.invocation.targetThreadId,
      content: buildScheduledEvalInvocationMessage(this.input.invocation, {
        channel: this.input.channel,
        windowKey: this.window.windowKey,
        dedupeKey: this.dedupeKey,
      }),
      userId: 'scheduler',
      idempotencyKey: this.dedupeKey,
    });
    if (!messageId) throw new Error('scheduled eval delivery returned no message id');
    return messageId;
  }

  private async wakeCat(messageId: string): Promise<'dispatched' | 'trigger_full' | 'trigger_failed'> {
    if (!this.input.invokeTrigger) return 'dispatched';
    try {
      const outcome = await this.input.invokeTrigger.trigger(
        this.input.invocation.targetThreadId,
        this.input.invocation.evalCat.catId,
        this.input.defaultUserId ?? 'default-user',
        this.input.triggerReason,
        messageId,
        undefined,
        {
          sourceCategory: this.input.channel === 'time' ? 'scheduled' : 'eval-threshold',
          reason: this.input.triggerReason,
        },
      );
      return outcome === 'full' ? 'trigger_full' : 'dispatched';
    } catch {
      return 'trigger_failed';
    }
  }

  private async completeClaims(): Promise<boolean> {
    if (!this.guardedByStore || !this.input.store) return true;
    const policy = this.input.domain.triggerPolicy;
    const windowCompleted = await this.input.store.complete({
      ...this.windowReceipt,
      channel: this.input.channel,
      nowMs: this.nowMs,
      cooldownUntilMs: policy.mode === 'threshold_or_time' ? this.nowMs + policy.cooldownHours * HOUR_MS : undefined,
    });
    if (!windowCompleted) return false;
    return this.eventReceipt ? this.tryComplete(this.eventReceipt) : true;
  }

  private async tryClaim(receipt: EvalDomainTriggerReceiptRef): Promise<EvalDomainTriggerClaimResult | null> {
    try {
      return (await this.input.store?.claim({ ...receipt, nowMs: this.nowMs, leaseMs: CLAIM_LEASE_MS })) ?? null;
    } catch {
      return null;
    }
  }

  private async tryComplete(receipt: EvalDomainTriggerReceiptRef): Promise<boolean> {
    try {
      return (
        (await this.input.store?.complete({ ...receipt, channel: this.input.channel, nowMs: this.nowMs })) ?? false
      );
    } catch {
      return false;
    }
  }

  private async releaseClaims(): Promise<void> {
    if (!this.input.store) return;
    await Promise.allSettled(this.claimed.map((receipt) => this.input.store?.release(receipt)));
  }

  private outcome(outcome: EvalDomainTriggerDispatchOutcome): EvalDomainTriggerDispatchResult {
    return result(outcome, this.window.windowKey, this.dedupeKey);
  }
}
