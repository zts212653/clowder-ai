import { randomUUID } from 'node:crypto';
import type { OwnedQueueProgress } from '../../../domains/cats/services/agents/invocation/PersistedQueueCarrier.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import type { EvalDomainId } from '../domain/eval-domain-registry.js';
import { buildEvalCatInvocation } from '../eval-cat-invocation.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import type { HandlerError, ManualTriggerDeps } from './types.js';

export interface TriggerNowInput {
  domainId: string;
  userId: string;
}

/**
 * The Queue's own lifecycle verdict for this admission, passed through rather than collapsed.
 * Only the Queue can answer the caller's real question — "will the eval cat actually run for
 * this packet?" — so folding every state into one `'dispatched'` would report a busy, paused or
 * already-terminal row as a successful wake.
 */
export type TriggerNowAdmissionState = OwnedQueueProgress;

export interface TriggerNowSuccess {
  ok: true;
  domainId: string;
  threadId: string;
  messageId: string;
  evalCatId: string;
  /** Exact Queue lifecycle state for this admission — never collapsed into a single value. */
  admissionState: TriggerNowAdmissionState;
  /**
   * Whether this admission leaves a run in flight or pending. Derived from `admissionState`,
   * never asserted independently:
   *  - `false` for `terminal_owned` — the row is already terminal, so no wake follows this call.
   *  - `false` for `owned_deferred_suppressed` — admitted, but auto-resume is off, so it will not
   *    run until the cat is resumed.
   * Both would otherwise be reported to the operator as a successful trigger that never runs.
   */
  invocationTriggered: boolean;
}

/** `terminal_owned` has no wake left to await; `owned_deferred_suppressed` waits on the operator. */
function leavesRunPending(state: TriggerNowAdmissionState): boolean {
  return state !== 'terminal_owned' && state !== 'owned_deferred_suppressed';
}

/**
 * F192 OQ-21: Manual eval trigger — true wake via late-bound invokeTrigger.
 *
 * Replaces abandoned PR #2091 (4.6's approach taught eval cats `git push origin
 * main` — violates §5 rule #2). The packet and the eval cat's wake cross one
 * atomic Message+Queue admission, so a refused admission publishes nothing.
 *
 * Late-binding: invokeTrigger is created after eval-hub routes register (index.ts
 * ~line 2600); the provider pattern returns null until wired.
 */
export async function handleTriggerNow(
  deps: ManualTriggerDeps,
  input: TriggerNowInput,
): Promise<TriggerNowSuccess | HandlerError> {
  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domain = domains.get(input.domainId as Parameters<typeof domains.get>[0]);
  if (!domain) {
    return { status: 400, error: `Domain '${input.domainId}' not registered in eval-domains/` };
  }

  const delivery = deps.invokeTriggerProvider?.get();
  if (!delivery) {
    return {
      status: 503,
      error: 'delivery not ready',
      detail: 'Server still initializing — manual eval trigger unavailable until Queue admission is wired',
    };
  }

  // Apply Redis evalCat override if configured (OQ-20: community users may pick a different cat).
  let effectiveDomain = domain;
  if (deps.redis) {
    const override = await getEvalCatOverride(deps.redis, input.domainId);
    if (override) {
      effectiveDomain = {
        ...domain,
        evalCat: { catId: override.catId, handle: override.handle, model: override.model },
      };
    }
  }

  if (deps.threadStore) {
    try {
      await ensureEvalDomainThreads(
        deps.threadStore,
        [
          {
            domainId: domain.domainId,
            systemThreadId: domain.systemThreadId,
            displayName: domain.displayName,
          },
        ],
        input.userId,
      );
    } catch {
      // Best-effort; manual trigger still works without it
    }
  }

  const invocation = buildEvalCatInvocation(
    {
      domain: effectiveDomain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    },
    // cloud R5 P2 (PR-2): gate publish instructions on actual runtime support so
    // cats don't waste a run producing a packet they can't publish (501 from
    // handler when generator wire skipped — e.g. cw + no Redis).
    {
      wiredPublishDomains: deps.wiredPublishDomains as ReadonlySet<EvalDomainId> | undefined,
    },
  );

  const content = [
    `## Eval Domain: ${invocation.domainId} (manual trigger by ${input.userId})`,
    '',
    invocation.instructions,
    '',
    '```json',
    JSON.stringify(invocation.context, null, 2),
    '```',
  ].join('\n');

  // One admission: the packet becomes a thread message and the eval cat's wake in the same
  // transaction. There is no window where the packet is visible but nobody was woken for it.
  //
  // Every *refusal* lands on the same 503, because under one atomic admission they all mean the
  // same thing to the caller: nothing was admitted, so nothing was published and nobody was woken.
  // `deliver()` refuses two different ways — `conflict`/`unavailable` by return value, and a
  // `ROUTE_QUEUE_FULL` throw at capacity — and letting the throw escape surfaced back-pressure as
  // a 500. Only that typed refusal is converted: an unexpected fault still propagates, because
  // reporting a real bug as "retry once the queue drains" would hide it behind an endless retry.
  let admitted: Awaited<ReturnType<typeof delivery.deliver>>;
  try {
    admitted = await delivery.deliver({
      ownerUserId: input.userId,
      threadId: invocation.targetThreadId,
      targetCatId: invocation.evalCat.catId,
      // Each accepted manual trigger is its own occurrence by design — the operator asking twice
      // means two runs. A wall-clock stamp is not an identity: two clicks inside the same
      // millisecond would collide onto one key and silently drop the second run.
      idempotencyKey: `manual-eval-trigger:${input.domainId}:${randomUUID()}`,
      content,
      source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
    });
  } catch (err) {
    if (!isQueueFullRefusal(err)) throw err;
    return queueUnavailable(invocation.targetThreadId);
  }
  if (admitted.state === 'conflict' || admitted.state === 'unavailable') {
    return queueUnavailable(invocation.targetThreadId);
  }
  const messageId = admitted.message?.id ?? '';

  return {
    ok: true,
    domainId: input.domainId,
    threadId: invocation.targetThreadId,
    messageId,
    evalCatId: invocation.evalCat.catId,
    admissionState: admitted.state,
    invocationTriggered: leavesRunPending(admitted.state),
  };
}

/** The Queue's typed at-capacity refusal, as thrown by `PersistedQueueDelivery.deliver()`. */
function isQueueFullRefusal(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ROUTE_QUEUE_FULL';
}

function queueUnavailable(threadId: string): HandlerError {
  return {
    status: 503,
    error: 'invocation_queue_unavailable',
    detail: `Eval thread ${threadId} could not admit the manual trigger, so no wake was scheduled. Nothing was published either — retry once the queue drains.`,
  };
}
