import type { Redis } from 'ioredis';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';

/**
 * F192 OQ-21 — Shared types for manual eval trigger handlers.
 *
 * Split from `routes/eval-hub.ts` per cloud codex R5 P1 (file size 350-line
 * hard limit per AGENTS.md). See `trigger-now.ts` + `generate-now.ts` for
 * the actual handlers.
 */

/**
 * Matches the `TriggerOutcome` return type of `ConnectorInvokeTrigger.trigger()`:
 *  - `'dispatched'` — cat invocation started in background immediately
 *  - `'enqueued'`  — thread busy, queued; processor will pick up when slot frees
 *  - `'full'`      — thread queue at capacity, **invocation dropped, not retried**
 */
export type InvokeTriggerOutcome = 'dispatched' | 'enqueued' | 'full';

export interface InvokeTriggerLike {
  trigger(
    threadId: string,
    catId: string,
    userId: string,
    reason: string,
    messageId: string,
  ): InvokeTriggerOutcome | Promise<InvokeTriggerOutcome>;
}

/**
 * Late-bound provider — eval-hub routes register before invokeTrigger is
 * constructed in index.ts. Provider returns null until index.ts wires it.
 */
export interface InvokeTriggerProvider {
  get(): InvokeTriggerLike | null;
}

export interface ManualTriggerDeps {
  harnessFeedbackRoot: string;
  invokeTriggerProvider?: InvokeTriggerProvider;
  messageStore?: Pick<IMessageStore, 'append'>;
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
