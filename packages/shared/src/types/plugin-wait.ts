import type { WaitOutcomeDelivery } from './wait-contract.js';
import type { WaitTerminationReason } from './wait-termination.js';

/** Host continuation projection only. Provider predicates and baselines stay in the plugin. */
export interface PluginWaitUpdate {
  readonly expectedGeneration: number | null;
  readonly generation: number;
  readonly active: { readonly expiresAt?: number } | null;
  readonly outcome?: {
    readonly outcomeId: string;
    readonly generation: number;
    readonly ownerFence: { readonly kind: 'containing_task'; readonly generation: number };
    readonly reason: WaitTerminationReason;
    readonly delivery: WaitOutcomeDelivery;
  };
}

export interface PluginWaitState {
  /** Host task mutation revoked this projection; only a new authenticated registration may replace it. */
  readonly invalidated?: 'owner_changed' | 'user_cancel';
  readonly pluginInstanceId: string;
  readonly generation: number;
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly await?: { readonly generation: number; readonly expiresAt?: number };
  readonly waitOutcome?: PluginWaitUpdate['outcome'];
  readonly registration?: {
    readonly invocationId: string;
    readonly source: {
      readonly kind: 'primary' | 'adopted_hold';
      readonly sourceMessageId: string;
      readonly holdTaskId?: string;
    };
    readonly registeredAt: number;
  };
}
