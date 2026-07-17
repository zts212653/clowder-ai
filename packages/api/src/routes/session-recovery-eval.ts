import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { formatEventsChat, formatEventsHandoff } from '../domains/cats/services/session/TranscriptFormatter.js';
import type { ReadEventsResult, TranscriptEvent } from '../domains/cats/services/session/TranscriptReader.js';
import { resolveEvalCatAccessPolicy } from '../infrastructure/harness-eval/domain/eval-cat-access.js';
import { selectSessionRecoveryOpeningEvidence } from '../infrastructure/harness-eval/session-recovery/session-recovery-opening-evidence.js';
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

interface SessionRecoveryTrialResolver {
  resolve(selector: SessionRecoverySourceSelector, scope: { ownerUserId: string }): Promise<SessionRecoveryTrial[]>;
  resolveTrial(
    selector: SessionRecoverySourceSelector,
    trialId: string,
    scope: { ownerUserId: string },
  ): Promise<SessionRecoveryTrial>;
}

interface SessionRecoveryEvidenceTranscriptReader {
  readEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    cursor?: { eventNo: number },
    limit?: number,
  ): Promise<ReadEventsResult>;
  readDigest(sessionId: string, threadId: string, catId: string): Promise<Record<string, unknown> | null>;
  readInvocationEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    invocationId: string,
  ): Promise<TranscriptEvent[] | null>;
}

export interface SessionRecoveryEvalRoutesOptions {
  trialProvider: SessionRecoveryTrialResolver;
  transcriptReader: SessionRecoveryEvidenceTranscriptReader;
  harnessFeedbackRoot: string;
  redis?: Redis;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

type EvidenceKind = 'source_digest' | 'source_events' | 'target_opening_invocation';
type EvidenceView = 'raw' | 'chat' | 'handoff';

interface EvidenceRequest {
  selector: SessionRecoverySourceSelector;
  trialId: string;
  evidenceKind: EvidenceKind;
  cursor?: number;
  eventLimit?: number;
  view: EvidenceView;
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
  target: PreviewSessionRef;
  firstInvocationId?: string;
  terminalEventRef?: string;
  transcriptEvidenceStatus: SessionRecoveryTrial['transcriptEvidenceStatus'];
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

  app.post(`/api/eval-domains/${DOMAIN_ID}/read-evidence`, async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation' && principal.kind !== 'agent_key') {
      return reply.status(403).send({ error: 'invocation_or_agent_key_principal_required' });
    }
    const evalCatAccess = await resolveEvalCatAccessPolicy(opts, DOMAIN_ID);
    if (!evalCatAccess.registered || principal.catId !== evalCatAccess.allowedCatId) {
      return reply.status(403).send({ error: 'not_allowed' });
    }

    const parsed = parseEvidenceRequest(request.body);
    if ('error' in parsed) {
      return reply.status(400).send({ error: 'invalid_evidence_request', detail: parsed.error });
    }
    try {
      const trial = await opts.trialProvider.resolveTrial(parsed.selector, parsed.trialId, {
        ownerUserId: principal.userId,
      });
      return await readTrialEvidence(opts.transcriptReader, trial, parsed);
    } catch (error) {
      return sendEvidenceError(reply, error);
    }
  });
};

function parseEvidenceRequest(value: unknown): EvidenceRequest | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'body must be an object' };
  const body = value as Record<string, unknown>;
  const trialId = body.trialId;
  if (
    typeof trialId !== 'string' ||
    !trialId.startsWith('session-recovery:') ||
    trialId.length === 'session-recovery:'.length ||
    /[\r\n]/.test(trialId)
  ) {
    return { error: 'trialId must be a non-empty single-line session-recovery anchor' };
  }
  const evidenceKinds = new Set<EvidenceKind>(['source_digest', 'source_events', 'target_opening_invocation']);
  if (typeof body.evidenceKind !== 'string' || !evidenceKinds.has(body.evidenceKind as EvidenceKind)) {
    return { error: 'evidenceKind must be source_digest, source_events, or target_opening_invocation' };
  }
  const pagingError = validateEvidencePaging(body);
  if (pagingError) return { error: pagingError };
  const view = body.view ?? 'raw';
  if (view !== 'raw' && view !== 'chat' && view !== 'handoff') {
    return { error: 'view must be raw, chat, or handoff' };
  }
  return {
    selector: selectEvidenceSelector(body.selector),
    trialId,
    evidenceKind: body.evidenceKind as EvidenceKind,
    ...(body.cursor !== undefined ? { cursor: body.cursor as number } : {}),
    ...(body.eventLimit !== undefined ? { eventLimit: body.eventLimit as number } : {}),
    view,
  };
}

function validateEvidencePaging(body: Record<string, unknown>): string | null {
  if (body.cursor !== undefined && (!Number.isSafeInteger(body.cursor) || (body.cursor as number) < 0)) {
    return 'cursor must be a non-negative safe integer';
  }
  if (
    body.eventLimit !== undefined &&
    (!Number.isSafeInteger(body.eventLimit) || (body.eventLimit as number) < 1 || (body.eventLimit as number) > 200)
  ) {
    return 'eventLimit must be an integer between 1 and 200';
  }
  return null;
}

function selectEvidenceSelector(value: unknown): SessionRecoverySourceSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value as SessionRecoverySourceSelector;
  }
  const selector = value as Record<string, unknown>;
  return {
    kind: selector.kind as SessionRecoverySourceSelector['kind'],
    windowStartMs: selector.windowStartMs as number,
    windowEndMs: selector.windowEndMs as number,
    ...(selector.catId !== undefined ? { catId: selector.catId as string } : {}),
    ...(selector.threadId !== undefined ? { threadId: selector.threadId as string } : {}),
    ...(selector.limit !== undefined ? { limit: selector.limit as number } : {}),
  };
}

async function readTrialEvidence(
  transcriptReader: SessionRecoveryEvidenceTranscriptReader,
  trial: SessionRecoveryTrial,
  request: EvidenceRequest,
): Promise<Record<string, unknown>> {
  const ref = request.evidenceKind.startsWith('source_') ? trial.source : trial.target;
  const session = toPreviewSessionRef(ref);
  if (request.evidenceKind === 'source_digest') {
    const digest = await transcriptReader.readDigest(ref.sessionId, ref.threadId, ref.catId);
    if (!digest) throw new Error(`session_recovery_evidence_not_found: digest:${ref.sessionId}`);
    return { trialId: trial.trialId, evidenceKind: request.evidenceKind, session, digest };
  }
  if (request.evidenceKind === 'target_opening_invocation') {
    if (!trial.firstInvocationId) {
      throw new Error(`session_recovery_evidence_not_found: opening invocation:${trial.trialId}`);
    }
    const events = await transcriptReader.readInvocationEvents(
      ref.sessionId,
      ref.threadId,
      ref.catId,
      trial.firstInvocationId,
    );
    if (!events) throw new Error(`session_recovery_evidence_not_found: invocation:${trial.firstInvocationId}`);
    const bounded = selectSessionRecoveryOpeningEvidence(events);
    return {
      trialId: trial.trialId,
      evidenceKind: request.evidenceKind,
      session,
      invocationId: trial.firstInvocationId,
      events: withEvidenceRefs(ref.sessionId, bounded),
      total: events.length,
      ...(events.length > bounded.length ? { truncated: true } : {}),
    };
  }

  const result = await transcriptReader.readEvents(
    ref.sessionId,
    ref.threadId,
    ref.catId,
    request.cursor === undefined ? undefined : { eventNo: request.cursor },
    request.eventLimit ?? 50,
  );
  const base = {
    trialId: trial.trialId,
    evidenceKind: request.evidenceKind,
    session,
    nextCursor: result.nextCursor,
    total: result.total,
    // Source transcript events are read-only assessment context. The provider's
    // replayable allowlist owns only the canonical source Session anchor.
    evidenceRefs: [ref.evidenceRef],
  };
  if (request.view === 'chat') return { ...base, messages: formatEventsChat(result.events) };
  if (request.view === 'handoff') return { ...base, invocations: formatEventsHandoff(result.events) };
  return { ...base, events: result.events };
}

function withEvidenceRefs(
  sessionId: string,
  events: TranscriptEvent[],
): Array<TranscriptEvent & { evidenceRef: string }> {
  return events.map((event) => ({ ...event, evidenceRef: transcriptRef(sessionId, event.eventNo) }));
}

function transcriptRef(sessionId: string, eventNo: number): string {
  return `transcript:${sessionId}:event:${eventNo}`;
}

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
  return {
    trialId: trial.trialId,
    source: toPreviewSessionRef(trial.source),
    target: toPreviewSessionRef(trial.target),
    ...(trial.firstInvocationId ? { firstInvocationId: trial.firstInvocationId } : {}),
    ...(trial.terminalEventRef ? { terminalEventRef: trial.terminalEventRef } : {}),
    transcriptEvidenceStatus: trial.transcriptEvidenceStatus,
    ...(trial.transcriptEvidenceTruncated ? { transcriptEvidenceTruncated: true } : {}),
    evidenceRefs,
    evidenceRefCount: trial.evidenceRefs.length,
    ...(trial.evidenceRefs.length > evidenceRefs.length ? { evidenceRefsTruncated: true } : {}),
  };
}

function boundedEvidenceRefs(trial: SessionRecoveryTrial): string[] {
  const priority = [
    trial.source.evidenceRef,
    trial.target.evidenceRef,
    trial.firstInvocationId ? `invocation:${trial.firstInvocationId}` : undefined,
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
    detail.startsWith('foreign first meaningful event ref:') ||
    detail.startsWith('first meaningful event evidence ref is required:') ||
    detail.startsWith('first meaningful event must belong to the target opening invocation:') ||
    detail.startsWith('semantic assessment requires available transcript evidence:') ||
    detail.startsWith('semantic assessment requires a target transcript evidence ref:') ||
    detail.startsWith('duplicate assessment trialId:')
  ) {
    return reply.status(400).send({ error: 'invalid_assessment', detail });
  }
  if (detail.startsWith('session_scan_limit_reached:')) {
    return reply.status(400).send({ error: 'window_too_broad', detail });
  }
  return reply.status(500).send({ error: 'session_recovery_preview_failed' });
}

function sendEvidenceError(reply: FastifyReply, error: unknown): unknown {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith('invalid_selector:')) {
    return reply.status(400).send({ error: 'invalid_selector', detail });
  }
  if (detail.startsWith('invalid_evidence_request:')) {
    return reply.status(400).send({ error: 'invalid_evidence_request', detail });
  }
  if (detail.startsWith('session_recovery_evidence_not_found:')) {
    return reply.status(404).send({ error: 'evidence_not_found', detail });
  }
  if (detail.startsWith('owner_user_required:')) {
    return reply.status(401).send({ error: 'unauthenticated', detail });
  }
  return reply.status(500).send({ error: 'session_recovery_evidence_read_failed' });
}
