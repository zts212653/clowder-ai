import type { SessionRecord } from '@cat-cafe/shared';
import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';
import {
  SESSION_RECOVERY_OPENING_EVIDENCE_EVENT_LIMIT,
  selectSessionRecoveryOpeningEvidence,
} from './session-recovery-opening-evidence.js';
import type {
  SessionEvidenceRef,
  SessionRecoveryAssessment,
  SessionRecoveryResolveScope,
  SessionRecoverySourceSelector,
  SessionRecoveryTranscriptEvidenceStatus,
  SessionRecoveryTrial,
  SessionRecoveryTrialProviderDeps,
} from './session-recovery-types.js';

const MAX_WINDOW_MS = 31 * 86_400_000;
const DEFAULT_TRIAL_LIMIT = 50;
const MAX_TRIAL_LIMIT = 200;
const MAX_ASSESSMENT_EVIDENCE_REFS = 100;

interface TranscriptEvidence {
  transcriptEvidenceStatus: SessionRecoveryTranscriptEvidenceStatus;
  firstInvocationId?: string;
  terminalEventRef?: string;
  transcriptEvidenceTruncated?: boolean;
  evidenceRefs: string[];
}

export class SessionRecoveryTrialProvider {
  private readonly deps: SessionRecoveryTrialProviderDeps;

  constructor(deps: SessionRecoveryTrialProviderDeps) {
    if (!deps.sessionStore) throw new Error('SessionRecoveryTrialProvider: missing required port sessionStore');
    if (!deps.transcriptReader) {
      throw new Error('SessionRecoveryTrialProvider: missing required port transcriptReader');
    }
    this.deps = deps;
  }

  async resolve(
    selector: SessionRecoverySourceSelector,
    scope: SessionRecoveryResolveScope = {},
  ): Promise<SessionRecoveryTrial[]> {
    const selectorError = validateSessionRecoverySelector(selector);
    if (selectorError) throw new Error(`invalid_selector: ${selectorError}`);
    if (!scope.ownerUserId) throw new Error('owner_user_required: session-recovery window scan requires ownerUserId');

    const targets = await this.deps.sessionStore.scanContinuationTargets({
      ownerUserId: scope.ownerUserId,
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
      ...(selector.catId ? { catId: selector.catId } : {}),
      ...(selector.threadId ? { threadId: selector.threadId } : {}),
      limit: selector.limit ?? DEFAULT_TRIAL_LIMIT,
    });

    const trials = await Promise.all(targets.map((target) => this.projectTargetTrial(target)));
    return attachAssessments(trials, selector.assessments ?? []);
  }

  /**
   * Resolve one caller-supplied trial anchor inside an authenticated owner/window scope.
   * This intentionally does not scan by `limit`: a trial returned by preview remains
   * drillable if a newer target enters the same window before the next tool call.
   */
  async resolveTrial(
    selector: SessionRecoverySourceSelector,
    trialId: string,
    scope: SessionRecoveryResolveScope = {},
  ): Promise<SessionRecoveryTrial> {
    const selectorError = validateSessionRecoverySelector(selector);
    if (selectorError) throw new Error(`invalid_selector: ${selectorError}`);
    if (!scope.ownerUserId) throw new Error('owner_user_required: session-recovery trial read requires ownerUserId');
    if (!trialId.startsWith('session-recovery:') || /[\r\n]/.test(trialId)) {
      throw new Error('invalid_evidence_request: trialId must be a single-line session-recovery anchor');
    }
    const targetId = trialId.slice('session-recovery:'.length);
    if (!targetId) throw new Error('invalid_evidence_request: trialId target must not be empty');
    const target = await this.deps.sessionStore.get(targetId);
    if (!target || !targetMatchesSelector(target, selector, scope.ownerUserId)) {
      throw new Error(`session_recovery_evidence_not_found: ${trialId}`);
    }
    return this.projectTargetTrial(target);
  }

  private async projectTargetTrial(target: SessionRecord): Promise<SessionRecoveryTrial> {
    const sourceId = target.continuedFromSessionId;
    if (!sourceId) throw new Error(`invalid_continuation_target: missing backlink on ${target.id}`);
    const source = await this.deps.sessionStore.get(sourceId);
    if (!source) throw new Error(`invalid_continuation_target: source not found for ${target.id}`);
    const eligibilityIssue = continuationEligibilityIssue(source, target);
    if (eligibilityIssue) {
      throw new Error(`invalid_continuation_target: ${target.id}: ${eligibilityIssue}`);
    }

    const transcript = await this.collectTranscriptEvidence(target);
    return {
      trialId: `session-recovery:${target.id}`,
      source: toEvidenceRef(source),
      target: toEvidenceRef(target),
      ...transcript,
      evidenceRefs: [`session:${source.id}`, `session:${target.id}`, ...transcript.evidenceRefs],
    };
  }

  private async collectTranscriptEvidence(target: SessionRecord): Promise<TranscriptEvidence> {
    const transcript = await this.readOpeningInvocationEvents(target);
    if (transcript.status !== 'available') {
      return { transcriptEvidenceStatus: transcript.status, evidenceRefs: [] };
    }
    const terminal = findTerminalEvent(transcript.events);
    return {
      firstInvocationId: transcript.invocationId,
      transcriptEvidenceStatus: 'available',
      ...(terminal ? { terminalEventRef: transcriptRef(target.id, terminal.eventNo) } : {}),
      ...(transcript.truncated ? { transcriptEvidenceTruncated: true } : {}),
      evidenceRefs: [
        `invocation:${transcript.invocationId}`,
        ...transcript.events.map((event) => transcriptRef(target.id, event.eventNo)),
      ],
    };
  }

  private async readOpeningInvocationEvents(target: SessionRecord): Promise<
    | {
        events: TranscriptEvent[];
        invocationId: string;
        truncated: boolean;
        status: 'available';
      }
    | {
        events: [];
        truncated: false;
        status: Exclude<SessionRecoveryTranscriptEvidenceStatus, 'available'>;
      }
  > {
    const events: TranscriptEvent[] = [];
    let invocationId = target.openedByInvocationId;
    let cursor: { eventNo: number } | undefined;
    let sawAnyEvent = false;
    let hasMore = false;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;

    for (let page = 0; page < MAX_PAGES; page++) {
      let result;
      try {
        result = await this.deps.transcriptReader.readEvents(
          target.id,
          target.threadId,
          target.catId,
          cursor,
          PAGE_SIZE,
        );
      } catch {
        return { events: [], truncated: false, status: 'read_failed' };
      }
      hasMore = result.nextCursor !== undefined;

      sawAnyEvent ||= result.events.length > 0;
      invocationId ??= result.events.find((event) => event.invocationId)?.invocationId;
      if (invocationId) {
        for (const event of result.events) {
          if (event.invocationId === invocationId) events.push(event);
          else if (events.length > 0 && event.invocationId) {
            return { events, invocationId, truncated: false, status: 'available' };
          }
        }
      }

      if (events.length >= SESSION_RECOVERY_OPENING_EVIDENCE_EVENT_LIMIT) {
        return {
          events: selectSessionRecoveryOpeningEvidence(events),
          invocationId: invocationId!,
          truncated: result.nextCursor !== undefined,
          status: 'available',
        };
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    if (!invocationId) {
      return { events: [], truncated: false, status: sawAnyEvent ? 'missing_invocation' : 'not_found' };
    }
    if (events.length === 0) return { events: [], truncated: false, status: 'not_found' };
    return { events, invocationId, truncated: hasMore, status: 'available' };
  }
}

export function validateSessionRecoverySelector(selector: unknown): string | null {
  if (!selector || typeof selector !== 'object') return 'selector must be an object';
  const value = selector as Record<string, unknown>;
  if (value.kind !== 'session-recovery-window') return `unknown selector kind: ${JSON.stringify(value.kind)}`;
  return validateWindow(value) ?? validateScopeFilters(value) ?? validateAssessments(value.assessments);
}

function validateWindow(value: Record<string, unknown>): string | null {
  const start = value.windowStartMs;
  const end = value.windowEndMs;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
    return 'windowStartMs must be a non-negative safe integer';
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 0) {
    return 'windowEndMs must be a non-negative safe integer';
  }
  if (end <= start) return 'windowEndMs must be > windowStartMs';
  if (end - start > MAX_WINDOW_MS) return 'window must not exceed 31 days';
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_TRIAL_LIMIT)
  ) {
    return `limit must be an integer between 1 and ${MAX_TRIAL_LIMIT}`;
  }
  return null;
}

function validateScopeFilters(value: Record<string, unknown>): string | null {
  for (const field of ['catId', 'threadId'] as const) {
    const candidate = value[field];
    if (candidate !== undefined && (typeof candidate !== 'string' || !candidate || /[\r\n]/.test(candidate))) {
      return `${field} must be a non-empty single-line string`;
    }
  }
  return null;
}

function validateAssessments(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'assessments must be an array';
  if (value.length > MAX_TRIAL_LIMIT) return `assessments must contain at most ${MAX_TRIAL_LIMIT} entries`;
  const seen = new Set<string>();
  for (const assessment of value) {
    const error = validateAssessmentShape(assessment);
    if (error) return error;
    const trialId = (assessment as SessionRecoveryAssessment).trialId;
    if (seen.has(trialId)) return `duplicate assessment trialId: ${trialId}`;
    seen.add(trialId);
  }
  return null;
}

function validateAssessmentShape(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'assessment must be an object';
  const assessment = value as Record<string, unknown>;
  if (
    typeof assessment.trialId !== 'string' ||
    !assessment.trialId.startsWith('session-recovery:') ||
    /[\r\n]/.test(assessment.trialId)
  ) {
    return 'assessment trialId must be a single-line session-recovery anchor';
  }
  if (!['recovered', 'stale', 'unknown'].includes(String(assessment.stateReconstruction))) {
    return 'invalid stateReconstruction';
  }
  if (!['aligned', 'repeated', 'misaligned', 'unknown'].includes(String(assessment.firstMeaningfulAction))) {
    return 'invalid firstMeaningfulAction';
  }
  if (
    assessment.firstMeaningfulEventRef !== undefined &&
    (typeof assessment.firstMeaningfulEventRef !== 'string' ||
      !assessment.firstMeaningfulEventRef ||
      /[\r\n]/.test(assessment.firstMeaningfulEventRef))
  ) {
    return 'firstMeaningfulEventRef must be a non-empty single-line string';
  }
  if (assessment.firstMeaningfulAction === 'unknown' && assessment.firstMeaningfulEventRef !== undefined) {
    return 'firstMeaningfulEventRef must be omitted when firstMeaningfulAction is unknown';
  }
  if (assessment.firstMeaningfulAction !== 'unknown' && assessment.firstMeaningfulEventRef === undefined) {
    return 'firstMeaningfulEventRef is required when firstMeaningfulAction is known';
  }
  if (!['continued', 'completed', 'failed', 'unknown'].includes(String(assessment.outcome))) {
    return 'invalid outcome';
  }
  if (
    !Array.isArray(assessment.evidenceRefs) ||
    assessment.evidenceRefs.length === 0 ||
    assessment.evidenceRefs.length > MAX_ASSESSMENT_EVIDENCE_REFS ||
    assessment.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref || /[\r\n]/.test(ref))
  ) {
    return `assessment evidenceRefs must contain 1-${MAX_ASSESSMENT_EVIDENCE_REFS} non-empty single-line strings`;
  }
  if (typeof assessment.rationale !== 'string' || !assessment.rationale.trim() || assessment.rationale.length > 4_000) {
    return 'assessment rationale must contain 1-4000 characters';
  }
  return null;
}

function attachAssessments(
  trials: SessionRecoveryTrial[],
  assessments: SessionRecoveryAssessment[],
): SessionRecoveryTrial[] {
  if (assessments.length === 0) return trials;
  const byTrial = new Map(trials.map((trial) => [trial.trialId, trial]));
  for (const assessment of assessments) {
    const trial = byTrial.get(assessment.trialId as SessionRecoveryTrial['trialId']);
    if (!trial) throw new Error(`unknown assessment trial: ${assessment.trialId}`);
    const allowedRefs = new Set(trial.evidenceRefs);
    for (const ref of assessment.evidenceRefs) {
      if (!allowedRefs.has(ref)) throw new Error(`foreign assessment evidence ref: ${ref}`);
    }
    if (assessment.firstMeaningfulEventRef && !allowedRefs.has(assessment.firstMeaningfulEventRef)) {
      throw new Error(`foreign first meaningful event ref: ${assessment.firstMeaningfulEventRef}`);
    }
    assertAssessmentHasSemanticEvidence(trial, assessment);
    trial.assessment = {
      ...assessment,
      evidenceRefs: [...assessment.evidenceRefs],
      rationale: assessment.rationale.trim(),
    };
  }
  return trials;
}

function assertAssessmentHasSemanticEvidence(trial: SessionRecoveryTrial, assessment: SessionRecoveryAssessment): void {
  const requiresTranscript =
    assessment.stateReconstruction !== 'unknown' ||
    assessment.firstMeaningfulAction !== 'unknown' ||
    assessment.outcome !== 'unknown';
  if (!requiresTranscript) return;
  if (trial.transcriptEvidenceStatus !== 'available' || !trial.firstInvocationId) {
    throw new Error(
      `semantic assessment requires available transcript evidence: ${trial.trialId} (${trial.transcriptEvidenceStatus})`,
    );
  }
  const invocationRef = `invocation:${trial.firstInvocationId}`;
  const transcriptPrefix = `transcript:${trial.target.sessionId}:event:`;
  if (!assessment.evidenceRefs.some((ref) => ref === invocationRef || ref.startsWith(transcriptPrefix))) {
    throw new Error(`semantic assessment requires a target transcript evidence ref: ${trial.trialId}`);
  }
  if (
    assessment.firstMeaningfulAction !== 'unknown' &&
    (!assessment.firstMeaningfulEventRef || !assessment.evidenceRefs.includes(assessment.firstMeaningfulEventRef))
  ) {
    throw new Error(`first meaningful event evidence ref is required: ${trial.trialId}`);
  }
  if (
    assessment.firstMeaningfulEventRef &&
    !assessment.firstMeaningfulEventRef.startsWith(`transcript:${trial.target.sessionId}:event:`)
  ) {
    throw new Error(`first meaningful event must belong to the target opening invocation: ${trial.trialId}`);
  }
}

function continuationEligibilityIssue(source: SessionRecord, target: SessionRecord): string | null {
  if (source.status !== 'sealed' && source.status !== 'sealing') return 'source_not_sealed';
  if (source.userId !== target.userId || source.catId !== target.catId || source.threadId !== target.threadId) {
    return 'source_target_identity_mismatch';
  }
  if (target.continuedFromSessionId !== source.id) return 'source_backlink_mismatch';
  if (target.seq !== source.seq + 1) return 'source_target_sequence_mismatch';
  if (target.createdAt < source.createdAt) return 'target_created_before_source';
  return null;
}

function targetMatchesSelector(
  target: SessionRecord,
  selector: SessionRecoverySourceSelector,
  ownerUserId: string,
): boolean {
  return (
    target.userId === ownerUserId &&
    target.createdAt >= selector.windowStartMs &&
    target.createdAt < selector.windowEndMs &&
    target.continuedFromSessionId !== undefined &&
    (!selector.catId || target.catId === selector.catId) &&
    (!selector.threadId || target.threadId === selector.threadId)
  );
}

function toEvidenceRef(record: SessionRecord): SessionEvidenceRef {
  return {
    sessionId: record.id,
    evidenceRef: `session:${record.id}`,
    threadId: record.threadId,
    catId: record.catId,
    userId: record.userId,
    seq: record.seq,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.sealedAt !== undefined ? { sealedAt: record.sealedAt } : {}),
  };
}

function transcriptRef(sessionId: string, eventNo: number): string {
  return `transcript:${sessionId}:event:${eventNo}`;
}

function findTerminalEvent(events: TranscriptEvent[]): TranscriptEvent | undefined {
  return [...events].reverse().find((event) => event.event.type === 'done' || event.event.type === 'error');
}
