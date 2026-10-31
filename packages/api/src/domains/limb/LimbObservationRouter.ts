import type { RedisClient } from '@cat-cafe/shared/utils';

import type { LimbEmbodimentBinding, LimbEmbodimentBindingStore } from './LimbEmbodimentBindingStore.js';

export interface LimbTouchObservation {
  readonly v: 1;
  readonly observationId: string;
  readonly nodeId: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly kind: 'touch';
  readonly payload: {
    readonly gesture: 'tap' | 'stroke';
    readonly durationMs: number;
    readonly confidence: number;
  };
}

export interface LimbTranscriptObservation {
  readonly v: 1;
  readonly observationId: string;
  readonly nodeId: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly kind: 'transcript';
  readonly payload: {
    readonly interactionId: string;
    readonly text: string;
    readonly language?: string;
    readonly captureDurationMs: number;
  };
}

export type LimbObservation = LimbTouchObservation | LimbTranscriptObservation;

export interface LimbObservationReceiptStore {
  claim(nodeId: string, observationId: string): Promise<boolean>;
  release(nodeId: string, observationId: string): Promise<void>;
}

export interface LimbTranscriptDelivery {
  deliverTranscript(input: {
    readonly binding: LimbEmbodimentBinding;
    readonly observation: LimbTranscriptObservation;
  }): Promise<{ readonly messageId: string }>;
}

export type LimbObservationRouteResult =
  | { readonly status: 'reflex_only' }
  | { readonly status: 'routed'; readonly messageId: string }
  | { readonly status: 'duplicate' }
  | { readonly status: 'unbound' }
  | { readonly status: 'stale' };

export interface LimbObservationRouterOptions {
  readonly bindingStore: LimbEmbodimentBindingStore;
  readonly receiptStore: LimbObservationReceiptStore;
  readonly delivery: LimbTranscriptDelivery;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly maxFutureSkewMs?: number;
}

export interface LimbObservationRouter {
  route(observation: LimbObservation): Promise<LimbObservationRouteResult>;
}

function receiptKey(nodeId: string, observationId: string): string {
  return `limb:observation-receipt:${nodeId}:${observationId}`;
}

export class RedisLimbObservationReceiptStore implements LimbObservationReceiptStore {
  constructor(private readonly redis: Pick<RedisClient, 'set' | 'del'>) {}

  async claim(nodeId: string, observationId: string): Promise<boolean> {
    // Completed receipt is retained without TTL so gateway restarts cannot replay it.
    return (await this.redis.set(receiptKey(nodeId, observationId), '1', 'NX')) === 'OK';
  }

  async release(nodeId: string, observationId: string): Promise<void> {
    await this.redis.del(receiptKey(nodeId, observationId));
  }
}

export class MemoryLimbObservationReceiptStore implements LimbObservationReceiptStore {
  private readonly receipts = new Set<string>();

  async claim(nodeId: string, observationId: string): Promise<boolean> {
    const key = receiptKey(nodeId, observationId);
    if (this.receipts.has(key)) return false;
    this.receipts.add(key);
    return true;
  }

  async release(nodeId: string, observationId: string): Promise<void> {
    this.receipts.delete(receiptKey(nodeId, observationId));
  }
}

export function createLimbObservationRouter(options: LimbObservationRouterOptions): LimbObservationRouter {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5_000;

  return {
    async route(observation): Promise<LimbObservationRouteResult> {
      const occurredAt = Date.parse(observation.occurredAt);
      const ageMs = now() - occurredAt;
      if (!Number.isFinite(occurredAt) || ageMs > maxAgeMs || ageMs < -maxFutureSkewMs) {
        return { status: 'stale' };
      }

      const binding = await options.bindingStore.get(observation.nodeId);
      if (!binding) {
        return { status: 'unbound' };
      }

      const claimed = await options.receiptStore.claim(observation.nodeId, observation.observationId);
      if (!claimed) {
        return { status: 'duplicate' };
      }

      if (observation.kind === 'touch') {
        return { status: 'reflex_only' };
      }

      try {
        const delivered = await options.delivery.deliverTranscript({ binding, observation });
        return { status: 'routed', messageId: delivered.messageId };
      } catch (error) {
        // Delivery uses observationId as its durable idempotency key. Releasing
        // the ingress claim makes a transient failure retryable without a new message.
        await options.receiptStore.release(observation.nodeId, observation.observationId);
        throw error;
      }
    },
  };
}
