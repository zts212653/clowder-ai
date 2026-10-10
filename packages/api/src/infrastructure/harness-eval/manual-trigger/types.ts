import type { Redis } from 'ioredis';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';

/**
 * F192 OQ-21 — Shared types for manual eval trigger handlers.
 *
 * Split from `routes/eval-hub.ts` per cloud codex R5 P1 (file size 350-line
 * hard limit per AGENTS.md). See `trigger-now.ts` + `generate-now.ts` for
 * the actual handlers.
 */

/**
 * RFC §5.1/§5.4: a manual eval trigger publishes a visible packet and hands the eval cat its own
 * exact input. Both cross the one component that owns durable admission — not an append followed
 * by a bind, which could leave the packet in the thread with nobody woken for it.
 */
export type EvalDeliveryLike =
  import('../../../domains/cats/services/agents/invocation/PersistedQueueDelivery.js').PersistedQueueDeliveryPort;

/**
 * Late-bound provider — eval-hub routes register before invokeTrigger is
 * constructed in index.ts. Provider returns null until index.ts wires it.
 */
export interface InvokeTriggerProvider {
  get(): EvalDeliveryLike | null;
}

export interface ManualTriggerDeps {
  harnessFeedbackRoot: string;
  invokeTriggerProvider?: InvokeTriggerProvider;
  threadStore?: IThreadStore;
  redis?: Redis;
  /**
   * cloud R5 P2 (PR-2): runtime-wired publish-verdict domain set. When provided,
   * `buildEvalCatInvocation` omits publish instructions for unwired domains so
   * cats don't waste a run producing a packet they can't publish (e.g. cw when
   * Redis-backed ports unavailable → handler returns 501). Omit/undefined →
   * legacy default (all known-wireable domains get publish instructions).
   */
  wiredPublishDomains?: ReadonlySet<string>;
}

export interface HandlerError {
  status: number;
  error: string;
  detail?: string;
}
