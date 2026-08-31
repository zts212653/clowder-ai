import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import type { EvalDomainId } from '../domain/eval-domain-registry.js';
import { buildEvalCatInvocation } from '../eval-cat-invocation.js';
import { formatUnitSemanticEvaluationPackets } from '../evaluation/UnitSemanticEvaluationCoordinator.js';
import { produceHarnessLedgerRunSnapshot } from '../harness-ledger-snapshot-provider.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import { formatSemanticSweepPacket } from '../trace-annotation/SemanticSweepCoordinator.js';
import type { HandlerError, ManualTriggerDeps } from './types.js';

export interface TriggerNowInput {
  domainId: string;
  userId: string;
  /**
   * Sol R1 P2-1: server-injected source thread coordinate.
   * Escalation: event.threadId (the thread where the guard rejection fired).
   * Manual trigger: invocation thread. Scheduled: undefined.
   * Fable ruling: must NOT be self-reported by eval cat — owner-scope discipline.
   */
  sourceThreadId?: string;
  /**
   * Sol R4 P1-1 / Fable ruling: escalation kind provenance.
   * 'confirmed' = episodeCount ≥ threshold (real eligible harm).
   * 'uncertainty_probe' = truncation-only conservative-true (incomplete scan).
   * Propagated to snapshot + bundle so eval cat knows probe's byReason
   * only covers the capped scan, not the full window.
   * Manual/scheduled triggers: undefined (not escalation-driven).
   */
  escalationKind?: 'confirmed' | 'uncertainty_probe';
}

export interface TriggerNowSuccess {
  ok: true;
  domainId: string;
  threadId: string;
  messageId: string;
  evalCatId: string;
  invocationTriggered: true;
  /**
   * Outcome of `ConnectorInvokeTrigger.trigger()`. `'enqueued'` reaches success;
   * `'full'` is converted to 503 (cloud codex R2 P2).
   */
  triggerOutcome: 'enqueued';
  /** F257: jobId from SemanticSweepCoordinator.prepare, for volume drain fencing. */
  semanticSweepJobId?: string;
  /** F257: frozen Unit semantic jobs included in this invocation. */
  unitEvaluationJobIds?: string[];
}

/**
 * F257 sub-item 1: Zero-event skip result.
 * Snapshot produced successfully but contains zero guard rejection events
 * in the observation window. Eval cat NOT invoked (LLM cost = 0).
 * This is a valid state, not an error.
 */
export interface TriggerNowSkipped {
  ok: true;
  domainId: string;
  skipped: true;
  reason: 'zero_events_in_window';
  evalRunId: string;
  windowSummary: string;
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
): Promise<TriggerNowSuccess | TriggerNowSkipped | HandlerError> {
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

  // KD-17 snapshot-first: for eval:harness-ledger, snapshot is REQUIRED.
  // No snapshot → 503 (fail-closed for manual trigger).
  let precomputedEvidence: string | undefined;
  let semanticSweepJobId: string | undefined; // F257: for volume drain fencing
  let unitEvaluationJobIds: string[] | undefined;
  if (input.domainId === 'eval:harness-ledger') {
    if (!deps.guardRejectionLog && !deps.semanticSweepCoordinator && !deps.unitSemanticEvaluationCoordinator) {
      return {
        status: 503,
        error: 'harness_ledger_snapshot_unavailable',
        detail:
          'KD-17: eval:harness-ledger requires GuardRejectionEventLog provider for snapshot-first invocation. Provider not wired at runtime.',
      };
    }
    try {
      const evidenceParts: string[] = [];
      const semantic = await deps.semanticSweepCoordinator?.prepare({
        ownerUserId: input.userId,
        evaluatorCatId: effectiveDomain.evalCat.catId,
        startMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        endMs: Date.now() + 1,
      });
      if (semantic) {
        evidenceParts.push(formatSemanticSweepPacket(semantic.packet));
        semanticSweepJobId = semantic.job.jobId;
      }
      const unitPackets = await deps.unitSemanticEvaluationCoordinator?.prepare({
        ownerUserId: input.userId,
        evaluatorCatId: effectiveDomain.evalCat.catId,
        now: Date.now(),
      });
      if (unitPackets && unitPackets.length > 0) {
        evidenceParts.push(formatUnitSemanticEvaluationPackets(unitPackets));
        unitEvaluationJobIds = unitPackets.map((packet) => packet.jobId);
      }

      let snapshotResult: Awaited<ReturnType<typeof produceHarnessLedgerRunSnapshot>> | null = null;
      if (deps.guardRejectionLog) {
        snapshotResult = await produceHarnessLedgerRunSnapshot({
          guardRejectionLog: deps.guardRejectionLog,
          harnessFeedbackRoot: deps.harnessFeedbackRoot,
          ownerUserId: input.userId,
          sourceThreadId: input.sourceThreadId,
          escalationKind: input.escalationKind,
        });
        evidenceParts.unshift(snapshotResult.summary);
      }

      if (snapshotResult?.snapshot.totalEvents === 0 && !semantic && !unitEvaluationJobIds?.length) {
        return {
          ok: true as const,
          domainId: input.domainId,
          skipped: true as const,
          reason: 'zero_events_in_window' as const,
          evalRunId: snapshotResult.evalRunId,
          windowSummary: `${snapshotResult.snapshot.window.durationHours}h window, 0 events`,
        };
      }
      precomputedEvidence = evidenceParts.join('\n\n');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        status: 503,
        error: 'harness_ledger_snapshot_failed',
        detail: `KD-17: snapshot production failed — ${detail}. Eval cat not invoked (no blind verdicts).`,
      };
    }
  }

  const invocation = buildEvalCatInvocation(
    {
      domain: effectiveDomain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
      precomputedEvidence,
    },
    // cloud R5 P2 (PR-2): gate publish instructions on actual runtime support so
    // cats don't waste a run producing a packet they can't publish (501 from
    // handler when generator wire skipped — e.g. cw + no Redis).
    {
      wiredPublishDomains: deps.wiredPublishDomains as ReadonlySet<EvalDomainId> | undefined,
    },
  );

  const contentParts = [
    `## Eval Domain: ${invocation.domainId} (manual trigger by ${input.userId})`,
    '',
    invocation.instructions,
    '',
    '```json',
    JSON.stringify(invocation.context, null, 2),
    '```',
  ];
  // KD-17: inject pre-computed evidence after context JSON
  if (invocation.precomputedEvidence) {
    contentParts.push('', invocation.precomputedEvidence);
  }
  const content = contentParts.join('\n');

  const stored = await deps.messageStore.append({
    from: { kind: 'system', service: 'eval-manual-trigger' },
    userId: input.userId,
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
    semanticSweepJobId,
    unitEvaluationJobIds,
  };
}
