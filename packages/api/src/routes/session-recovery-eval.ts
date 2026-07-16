import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type {
  SessionEvidenceRef,
  SessionRecoveryAssessment,
  SessionRecoverySourceSelector,
  SessionRecoveryTrial,
} from '../infrastructure/harness-eval/session-recovery/session-recovery-types.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook, requireCallbackPrincipal } from './callback-auth-prehandler.js';

const DOMAIN_ID = 'eval:session-recovery';
const MAX_PREVIEW_EVIDENCE_REFS = 25;
const MAX_PREVIEW_DUPLICATE_TARGETS = 10;

interface SessionRecoveryTrialResolver {
  resolve(selector: SessionRecoverySourceSelector, scope: { ownerUserId: string }): Promise<SessionRecoveryTrial[]>;
}

export interface SessionRecoveryEvalRoutesOptions {
  trialProvider: SessionRecoveryTrialResolver;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

interface PreviewSessionRef {
  sessionId: string;
  evidenceRef: string;
  threadId: string;
  catId: string;
  seq: number;
  status: string;
  createdAt: number;
  sealedAt?: number;
}

interface SessionRecoveryTrialPreview {
  trialId: string;
  source: PreviewSessionRef;
  target?: PreviewSessionRef;
  inferredTarget?: PreviewSessionRef;
  duplicateTargets?: PreviewSessionRef[];
  duplicateTargetCount?: number;
  duplicateTargetsTruncated?: boolean;
  lineage: SessionRecoveryTrial['lineage'];
  transitionIntegrity: SessionRecoveryTrial['transitionIntegrity'];
  delivery: SessionRecoveryTrial['delivery'];
  structuralIssues: string[];
  firstInvocationId?: string;
  firstMeaningfulEventRef?: string;
  terminalEventRef?: string;
  transcriptEvidenceTruncated?: boolean;
  evidenceRefs: string[];
  evidenceRefCount: number;
  evidenceRefsTruncated?: boolean;
}

export const sessionRecoveryEvalRoutes: FastifyPluginAsync<SessionRecoveryEvalRoutesOptions> = async (app, opts) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.post(`/api/eval-domains/${DOMAIN_ID}/preview-trials`, async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation' && principal.kind !== 'agent_key') {
      return reply.status(403).send({ error: 'invocation_or_agent_key_principal_required' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const selector = selectPreviewFields(body.selector);
    try {
      const trials = await opts.trialProvider.resolve(selector, { ownerUserId: principal.userId });
      return {
        selector: summarizeSelector(selector),
        count: trials.length,
        assessmentsValidated: selector.assessments?.length ?? 0,
        trials: trials.map(toTrialPreview),
      };
    } catch (error) {
      return sendPreviewError(reply, error);
    }
  });
};

function selectPreviewFields(value: unknown): SessionRecoverySourceSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value as SessionRecoverySourceSelector;
  }
  const input = value as Record<string, unknown>;
  return {
    kind: input.kind as SessionRecoverySourceSelector['kind'],
    windowStartMs: input.windowStartMs as number,
    windowEndMs: input.windowEndMs as number,
    ...(input.catId !== undefined ? { catId: input.catId as string } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId as string } : {}),
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
    ...(input.assessments !== undefined ? { assessments: input.assessments as SessionRecoveryAssessment[] } : {}),
  };
}

function summarizeSelector(
  selector: SessionRecoverySourceSelector,
): Omit<SessionRecoverySourceSelector, 'assessments'> {
  return {
    kind: selector.kind,
    windowStartMs: selector.windowStartMs,
    windowEndMs: selector.windowEndMs,
    ...(selector.catId ? { catId: selector.catId } : {}),
    ...(selector.threadId ? { threadId: selector.threadId } : {}),
    ...(selector.limit !== undefined ? { limit: selector.limit } : {}),
  };
}

function toTrialPreview(trial: SessionRecoveryTrial): SessionRecoveryTrialPreview {
  const evidenceRefs = boundedEvidenceRefs(trial);
  const duplicateTargets = trial.duplicateTargets?.slice(0, MAX_PREVIEW_DUPLICATE_TARGETS).map(toPreviewSessionRef);
  const duplicateTargetCount = trial.duplicateTargets?.length;
  return {
    trialId: trial.trialId,
    source: toPreviewSessionRef(trial.source),
    ...(trial.target ? { target: toPreviewSessionRef(trial.target) } : {}),
    ...(trial.inferredTarget ? { inferredTarget: toPreviewSessionRef(trial.inferredTarget) } : {}),
    ...(duplicateTargets && duplicateTargets.length > 0 ? { duplicateTargets } : {}),
    ...(duplicateTargetCount !== undefined ? { duplicateTargetCount } : {}),
    ...(duplicateTargetCount !== undefined && duplicateTargetCount > MAX_PREVIEW_DUPLICATE_TARGETS
      ? { duplicateTargetsTruncated: true }
      : {}),
    lineage: trial.lineage,
    transitionIntegrity: trial.transitionIntegrity,
    delivery: trial.delivery,
    structuralIssues: [...trial.structuralIssues],
    ...(trial.firstInvocationId ? { firstInvocationId: trial.firstInvocationId } : {}),
    ...(trial.firstMeaningfulEventRef ? { firstMeaningfulEventRef: trial.firstMeaningfulEventRef } : {}),
    ...(trial.terminalEventRef ? { terminalEventRef: trial.terminalEventRef } : {}),
    ...(trial.transcriptEvidenceTruncated ? { transcriptEvidenceTruncated: true } : {}),
    evidenceRefs,
    evidenceRefCount: trial.evidenceRefs.length,
    ...(trial.evidenceRefs.length > evidenceRefs.length ? { evidenceRefsTruncated: true } : {}),
  };
}

function boundedEvidenceRefs(trial: SessionRecoveryTrial): string[] {
  const priority = [
    trial.source.evidenceRef,
    trial.target?.evidenceRef,
    trial.inferredTarget?.evidenceRef,
    trial.firstInvocationId ? `invocation:${trial.firstInvocationId}` : undefined,
    trial.firstMeaningfulEventRef,
    trial.terminalEventRef,
  ].filter((ref): ref is string => Boolean(ref));
  return [...new Set(priority.concat(trial.evidenceRefs))].slice(0, MAX_PREVIEW_EVIDENCE_REFS);
}

function toPreviewSessionRef(ref: SessionEvidenceRef): PreviewSessionRef {
  return {
    sessionId: ref.sessionId,
    evidenceRef: ref.evidenceRef,
    threadId: ref.threadId,
    catId: ref.catId,
    seq: ref.seq,
    status: ref.status,
    createdAt: ref.createdAt,
    ...(ref.sealedAt !== undefined ? { sealedAt: ref.sealedAt } : {}),
  };
}

function sendPreviewError(reply: FastifyReply, error: unknown): unknown {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith('invalid_selector:')) {
    return reply.status(400).send({ error: 'invalid_selector', detail });
  }
  if (
    detail.startsWith('unknown assessment trial:') ||
    detail.startsWith('foreign assessment evidence ref:') ||
    detail.startsWith('duplicate assessment trialId:')
  ) {
    return reply.status(400).send({ error: 'invalid_assessment', detail });
  }
  if (detail.startsWith('session_scan_limit_reached:')) {
    return reply.status(400).send({ error: 'window_too_broad', detail });
  }
  return reply.status(500).send({ error: 'session_recovery_preview_failed' });
}
