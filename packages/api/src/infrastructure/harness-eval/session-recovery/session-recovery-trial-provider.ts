import type { SessionRecord } from '@cat-cafe/shared';
import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';
import { gradeSessionRecoveryStructure } from './session-recovery-grader.js';
import type {
  SessionEvidenceRef,
  SessionRecoveryAssessment,
  SessionRecoveryResolveScope,
  SessionRecoverySourceSelector,
  SessionRecoveryTrial,
  SessionRecoveryTrialProviderDeps,
} from './session-recovery-types.js';

const MAX_WINDOW_MS = 31 * 86_400_000;
const DEFAULT_TRIAL_LIMIT = 50;
const MAX_TRIAL_LIMIT = 200;
const MAX_SESSION_SCAN = 1000;
const MAX_EVIDENCE_EVENTS = 100;

interface TranscriptEvidence {
  firstInvocationId?: string;
  firstMeaningfulEventRef?: string;
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

    const records = await this.deps.sessionStore.scanAll({
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
      limit: MAX_SESSION_SCAN,
    });
    if (records.length >= MAX_SESSION_SCAN) {
      throw new Error(
        `session_scan_limit_reached: ${MAX_SESSION_SCAN} records matched; narrow window, catId, or threadId`,
      );
    }
    const owned = records.filter((record) => record.userId === scope.ownerUserId);
    const explicitBySource = groupExplicitTargets(owned);
    const limit = selector.limit ?? DEFAULT_TRIAL_LIMIT;
    const sourceCandidates = owned
      .filter((record) => record.status === 'sealed' || record.status === 'sealing')
      .filter((record) => {
        const transitionAt = record.sealedAt ?? record.updatedAt;
        return transitionAt >= selector.windowStartMs && transitionAt < selector.windowEndMs;
      })
      .filter((record) => !selector.catId || record.catId === selector.catId)
      .filter((record) => !selector.threadId || record.threadId === selector.threadId)
      .map((source) => ({
        source,
        explicitTargets: explicitBySource.get(source.id) ?? [],
        inferredTarget: findLegacyCandidate(owned, source),
      }))
      // A quiet threshold/manual seal is not a failed recovery. It becomes a trial only
      // when a target exists, a legacy next-session candidate exists, or F225 explicitly
      // committed to an immediate continuation.
      .filter(
        ({ source, explicitTargets, inferredTarget }) =>
          explicitTargets.length > 0 || inferredTarget !== undefined || source.sealReason === 'cat_initiated_handoff',
      )
      .sort((a, b) => (b.source.sealedAt ?? b.source.updatedAt) - (a.source.sealedAt ?? a.source.updatedAt))
      .slice(0, limit);

    const trials: SessionRecoveryTrial[] = [];
    for (const candidate of sourceCandidates) {
      trials.push(await this.projectTrial(candidate.source, candidate.explicitTargets, candidate.inferredTarget));
    }
    return attachAssessments(trials, selector.assessments ?? []);
  }

  private async projectTrial(
    source: SessionRecord,
    explicitTargets: SessionRecord[],
    inferredTarget?: SessionRecord,
  ): Promise<SessionRecoveryTrial> {
    const structural = gradeSessionRecoveryStructure({ source, explicitTargets, inferredTarget });
    const target = explicitTargets.length === 1 ? explicitTargets[0] : undefined;
    const evidenceTarget = target ?? (structural.lineage === 'legacy_unlinked' ? inferredTarget : undefined);
    const transcript = await this.collectTranscriptEvidence(evidenceTarget);
    const trial: SessionRecoveryTrial = {
      trialId: `session-recovery:${source.id}`,
      source: toEvidenceRef(source),
      lineage: structural.lineage,
      transitionIntegrity: structural.transitionIntegrity,
      delivery: structural.delivery,
      structuralIssues: structural.issues,
      ...transcript,
      evidenceRefs: collectSessionEvidenceRefs(source, target, inferredTarget, explicitTargets).concat(
        transcript.evidenceRefs,
      ),
    };
    if (target) trial.target = toEvidenceRef(target);
    if (explicitTargets.length > 1) trial.duplicateTargets = explicitTargets.map(toEvidenceRef);
    if (structural.lineage === 'legacy_unlinked' && inferredTarget) {
      trial.inferredTarget = toEvidenceRef(inferredTarget);
    }
    return trial;
  }

  private async collectTranscriptEvidence(target?: SessionRecord): Promise<TranscriptEvidence> {
    const invocationId = target?.openedByInvocationId;
    if (!target || !invocationId) return { evidenceRefs: [] };
    const transcript = await this.readInvocationEvents(target, invocationId);
    const firstMeaningful = transcript.events.find((event) => isMeaningfulEventType(event.event.type));
    const terminal = findTerminalEvent(transcript.events);
    return {
      firstInvocationId: invocationId,
      ...(firstMeaningful ? { firstMeaningfulEventRef: transcriptRef(target.id, firstMeaningful.eventNo) } : {}),
      ...(terminal ? { terminalEventRef: transcriptRef(target.id, terminal.eventNo) } : {}),
      ...(transcript.truncated ? { transcriptEvidenceTruncated: true } : {}),
      evidenceRefs: [
        `invocation:${invocationId}`,
        ...transcript.events.map((event) => transcriptRef(target.id, event.eventNo)),
      ],
    };
  }

  private async readInvocationEvents(
    target: SessionRecord,
    invocationId: string,
  ): Promise<{ events: TranscriptEvent[]; truncated: boolean }> {
    const events: TranscriptEvent[] = [];
    let cursor: { eventNo: number } | undefined;
    let foundInvocation = false;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.readTranscriptPage(target, cursor, PAGE_SIZE);
      if (!result) return { events: [], truncated: false };
      for (const event of result.events) {
        if (event.invocationId === invocationId) {
          foundInvocation = true;
          events.push(event);
        } else if (foundInvocation) {
          return { events, truncated: false };
        }
      }
      if (events.length >= MAX_EVIDENCE_EVENTS) {
        return { events: events.slice(0, MAX_EVIDENCE_EVENTS), truncated: result.nextCursor !== undefined };
      }
      if (!result.nextCursor) return { events, truncated: false };
      cursor = result.nextCursor;
    }
    return { events, truncated: cursor !== undefined };
  }

  private async readTranscriptPage(target: SessionRecord, cursor: { eventNo: number } | undefined, limit: number) {
    try {
      return await this.deps.transcriptReader.readEvents(target.id, target.threadId, target.catId, cursor, limit);
    } catch {
      return null;
    }
  }
}

export function validateSessionRecoverySelector(selector: unknown): string | null {
  if (!selector || typeof selector !== 'object') return 'selector must be an object';
  const value = selector as Record<string, unknown>;
  if (value.kind !== 'session-recovery-window') return `unknown selector kind: ${JSON.stringify(value.kind)}`;
  return validateWindow(value) ?? validateScopeFilters(value) ?? validateAssessments(value.assessments);
}

function validateWindow(value: Record<string, unknown>): string | null {
  if (typeof value.windowStartMs !== 'number' || !Number.isFinite(value.windowStartMs) || value.windowStartMs < 0) {
    return 'windowStartMs must be a non-negative finite number';
  }
  if (typeof value.windowEndMs !== 'number' || !Number.isFinite(value.windowEndMs)) {
    return 'windowEndMs must be a finite number';
  }
  if (value.windowEndMs <= value.windowStartMs) return 'windowEndMs must be > windowStartMs';
  if (value.windowEndMs - value.windowStartMs > MAX_WINDOW_MS) return 'window must not exceed 31 days';
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
  if (typeof assessment.trialId !== 'string' || !assessment.trialId) return 'assessment trialId is required';
  if (!['recovered', 'stale', 'unknown'].includes(String(assessment.stateReconstruction))) {
    return 'invalid stateReconstruction';
  }
  if (!['aligned', 'repeated', 'misaligned', 'unknown'].includes(String(assessment.firstMeaningfulAction))) {
    return 'invalid firstMeaningfulAction';
  }
  if (!['continued', 'completed', 'failed', 'unknown'].includes(String(assessment.outcome))) {
    return 'invalid outcome';
  }
  if (
    !Array.isArray(assessment.evidenceRefs) ||
    assessment.evidenceRefs.length === 0 ||
    assessment.evidenceRefs.length > MAX_EVIDENCE_EVENTS ||
    assessment.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref)
  ) {
    return `assessment evidenceRefs must contain 1-${MAX_EVIDENCE_EVENTS} non-empty strings`;
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
    trial.assessment = {
      ...assessment,
      evidenceRefs: [...assessment.evidenceRefs],
      rationale: assessment.rationale.trim(),
    };
  }
  return trials;
}

function groupExplicitTargets(records: SessionRecord[]): Map<string, SessionRecord[]> {
  const grouped = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const sourceId = record.continuationOrigin?.sourceSessionId;
    if (!sourceId) continue;
    const targets = grouped.get(sourceId) ?? [];
    targets.push(record);
    grouped.set(sourceId, targets);
  }
  return grouped;
}

function findLegacyCandidate(records: SessionRecord[], source: SessionRecord): SessionRecord | undefined {
  return records.find(
    (candidate) =>
      !candidate.continuationOrigin &&
      candidate.id !== source.id &&
      candidate.userId === source.userId &&
      candidate.threadId === source.threadId &&
      candidate.catId === source.catId &&
      candidate.seq === source.seq + 1,
  );
}

function collectSessionEvidenceRefs(
  source: SessionRecord,
  target: SessionRecord | undefined,
  inferredTarget: SessionRecord | undefined,
  explicitTargets: SessionRecord[],
): string[] {
  const refs = new Set<string>([`session:${source.id}`]);
  if (target) refs.add(`session:${target.id}`);
  if (inferredTarget) refs.add(`session:${inferredTarget.id}`);
  for (const duplicateTarget of explicitTargets.length > 1 ? explicitTargets : []) {
    refs.add(`session:${duplicateTarget.id}`);
  }
  return [...refs];
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

function isMeaningfulEventType(type: unknown): boolean {
  return type === 'text' || type === 'tool_use' || type === 'tool_result' || type === 'error';
}

function findTerminalEvent(events: TranscriptEvent[]): TranscriptEvent | undefined {
  return [...events].reverse().find((event) => event.event.type === 'done' || event.event.type === 'error');
}
