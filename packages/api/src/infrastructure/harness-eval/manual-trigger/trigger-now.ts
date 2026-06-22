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

export interface TriggerNowSuccess {
  ok: true;
  domainId: string;
  threadId: string;
  messageId: string;
  evalCatId: string;
  invocationTriggered: true;
  /**
   * Outcome of `ConnectorInvokeTrigger.trigger()`. Only `'dispatched'` or
   * `'enqueued'` reach success — `'full'` is converted to 503 (cloud codex R2 P2).
   */
  triggerOutcome: 'dispatched' | 'enqueued';
}

/**
 * F192 OQ-21: Manual eval trigger — true wake via late-bound invokeTrigger.
 *
 * Replaces abandoned PR #2091 (4.6's approach taught eval cats `git push origin
 * main` — violates §5 rule #2). New approach re-uses scheduler's invocation
 * pipeline (buildEvalCatInvocation + messageStore.append + invokeTrigger.trigger),
 * triggered manually via API.
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

  const trigger = deps.invokeTriggerProvider?.get();
  if (!trigger) {
    return {
      status: 503,
      error: 'invokeTrigger not ready',
      detail:
        'Server still initializing — manual eval trigger unavailable until invokeTrigger is constructed (index.ts ~line 2600)',
    };
  }

  if (!deps.messageStore) {
    return {
      status: 503,
      error: 'messageStore not available',
      detail: 'Manual trigger requires messageStore to deliver invocation packet',
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

  const stored = await deps.messageStore.append({
    userId: 'scheduler',
    catId: null,
    content,
    mentions: [],
    timestamp: Date.now(),
    threadId: invocation.targetThreadId,
  });
  const messageId = typeof stored === 'string' ? stored : stored.id;

  // 真 wake — call late-bound invokeTrigger (砚砚 R0 P1: NOT just messageStore.append).
  // Cloud codex R2 P2: capture TriggerOutcome — 'full' = queue at capacity,
  // invocation silently dropped; surface as 503.
  const outcome = await trigger.trigger(
    invocation.targetThreadId,
    invocation.evalCat.catId,
    input.userId,
    `Manual eval trigger: ${input.domainId}`,
    messageId,
  );

  if (outcome === 'full') {
    return {
      status: 503,
      error: 'invocation_queue_full',
      detail: `Eval thread ${invocation.targetThreadId} invocation queue is at capacity — the cat is busy with backlog. The message was delivered but the wake-up was NOT scheduled. Retry after the queue drains (typically a few seconds).`,
    };
  }

  return {
    ok: true,
    domainId: input.domainId,
    threadId: invocation.targetThreadId,
    messageId,
    evalCatId: invocation.evalCat.catId,
    invocationTriggered: true,
    triggerOutcome: outcome,
  };
}
