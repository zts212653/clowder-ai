import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { parseVerdictHandoffPacket, type VerdictHandoffPacket } from '../verdict-handoff.js';
import { formatSessionRecoveryLiveVerdictMarkdown } from './eval-session-recovery-renderer.js';
import { summarizeSessionRecoveryTrials } from './session-recovery-grader.js';
import type {
  SessionEvidenceRef,
  SessionRecoverySourceSelector,
  SessionRecoveryTrial,
} from './session-recovery-types.js';

const SAFE_VERDICT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SANITIZE_RULES_VERSION = 'f192-session-recovery-v1';
const MAX_RAW_EVIDENCE_REFS = 100;
const MAX_RAW_DUPLICATE_TARGETS = 25;

export interface GenerateSessionRecoveryLiveVerdictInput {
  verdictId: string;
  harnessFeedbackRoot: string;
  domain: EvalDomainRegistryEntry;
  selector: SessionRecoverySourceSelector;
  trials: SessionRecoveryTrial[];
  submittedPacket: VerdictHandoffPacket;
  generatedAt?: string;
  generatorCommit?: string;
}

export interface SessionRecoveryLiveVerdictArtifact {
  path: string;
  bundleDir: string;
  packet: VerdictHandoffPacket;
  markdown: string;
  isLive: true;
  sentCrossThreadMessage: false;
}

export function generateSessionRecoveryLiveVerdict(
  input: GenerateSessionRecoveryLiveVerdictInput,
): SessionRecoveryLiveVerdictArtifact {
  assertGeneratorInput(input);
  const bundleDir = join(input.harnessFeedbackRoot, 'bundles', input.verdictId);
  const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  const rawDir = join(bundleDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(input.harnessFeedbackRoot, 'verdicts'), { recursive: true });

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const rawPath = join(rawDir, 'session-recovery-trials.json');
  const sanitizedTrials = input.trials.map(sanitizeTrial);
  writeJson(rawPath, {
    verdictId: input.verdictId,
    selector: sanitizeSelector(input.selector),
    trials: sanitizedTrials,
  });

  const snapshot = buildSnapshot(input, generatedAt);
  const attribution = buildAttribution(input, generatedAt);
  const sessionRefs = uniqueRefs(input.trials, (ref) => ref.startsWith('session:'));
  const invocationEventRefs = keyInvocationEventRefs(input.trials);
  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));
  const provenance = {
    verdictId: input.verdictId,
    rawInputs: [
      {
        path: relative(repoRoot, rawPath).replace(/\\/g, '/'),
        sha256: sha256File(rawPath),
      },
    ],
    selector: sanitizeSelector(input.selector),
    sessionRefs,
    invocationEventRefs,
    generatedAt,
    generator: {
      name: 'eval-session-recovery-live-verdict',
      version: '1',
      ...(input.generatorCommit ? { commit: input.generatorCommit } : {}),
    },
    sanitizeRulesVersion: SANITIZE_RULES_VERSION,
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);

  const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: input.verdictId });
  const packetWithBundleRefs = parseVerdictHandoffPacket({
    ...input.submittedPacket,
    evidencePacket: {
      ...input.submittedPacket.evidencePacket,
      snapshotRefs: [resolved.snapshotRef],
      attributionRefs: resolved.attributionRefs,
    },
  });
  const markdown = formatSessionRecoveryLiveVerdictMarkdown(
    input.verdictId,
    packetWithBundleRefs,
    resolved.snapshotRef,
  );
  writeFileSync(verdictPath, markdown, 'utf8');

  return {
    path: verdictPath,
    bundleDir,
    packet: packetWithBundleRefs,
    markdown,
    isLive: true,
    sentCrossThreadMessage: false,
  };
}

function buildSnapshot(input: GenerateSessionRecoveryLiveVerdictInput, generatedAt: string) {
  const summary = summarizeSessionRecoveryTrials(input.trials);
  const assessments = input.trials.map((trial) => trial.assessment).filter((item) => item !== undefined);
  return {
    verdictId: input.verdictId,
    evalSnapshotId: `eval-F192-session-recovery-${generatedAt.slice(0, 10)}`,
    featureId: input.domain.handoffTargetResolver.featureId,
    generatedAt,
    window: {
      startMs: input.selector.windowStartMs,
      endMs: input.selector.windowEndMs,
      durationHours:
        Math.round(((input.selector.windowEndMs - input.selector.windowStartMs) / 3_600_000) * 1000) / 1000,
    },
    components: [
      {
        id: 'session-recovery',
        name: 'session recovery correctness',
        confidence: input.trials.length >= 3 ? 'medium' : 'low',
        activationCounts: {
          trial_total: summary.total,
          assessed_total: assessments.length,
          explicit_lineage_count: count(input.trials, (trial) => trial.lineage === 'explicit'),
          provider_dispatched_count: count(input.trials, (trial) => trial.delivery === 'provider_dispatched'),
          recovered_count: count(input.trials, (trial) => trial.assessment?.stateReconstruction === 'recovered'),
          aligned_count: count(input.trials, (trial) => trial.assessment?.firstMeaningfulAction === 'aligned'),
          continued_count: count(input.trials, (trial) => trial.assessment?.outcome === 'continued'),
          completed_count: count(input.trials, (trial) => trial.assessment?.outcome === 'completed'),
        },
        frictionCounts: {
          structural_fail_count: summary.structuralFail,
          structural_unknown_count: summary.structuralUnknown,
          semantic_fail_count: summary.semanticFail,
          semantic_unknown_count: summary.semanticUnknown,
          missing_target_count: count(input.trials, (trial) => trial.lineage === 'missing'),
          duplicate_target_count: count(input.trials, (trial) => trial.lineage === 'duplicate'),
          legacy_unlinked_count: count(input.trials, (trial) => trial.lineage === 'legacy_unlinked'),
          missing_receipt_count: count(input.trials, (trial) => trial.delivery === 'missing_receipt'),
          stale_count: count(input.trials, (trial) => trial.assessment?.stateReconstruction === 'stale'),
          repeated_count: count(input.trials, (trial) => trial.assessment?.firstMeaningfulAction === 'repeated'),
          misaligned_count: count(input.trials, (trial) => trial.assessment?.firstMeaningfulAction === 'misaligned'),
          failed_count: count(input.trials, (trial) => trial.assessment?.outcome === 'failed'),
        },
      },
    ],
  };
}

function buildAttribution(input: GenerateSessionRecoveryLiveVerdictInput, generatedAt: string) {
  const summary = summarizeSessionRecoveryTrials(input.trials);
  const findings = [];
  if (summary.structuralFail > 0) {
    findings.push(
      finding(
        'SR-STRUCTURAL',
        'structural_fail_count',
        summary.structuralFail,
        'transition-lineage',
        'inspect-transition-lineage',
        generatedAt,
      ),
    );
  }
  if (summary.semanticFail > 0) {
    findings.push(
      finding(
        'SR-SEMANTIC',
        'semantic_fail_count',
        summary.semanticFail,
        'state-reconstruction',
        'inspect-semantic-assessments',
        generatedAt,
      ),
    );
  }
  const base = {
    verdictId: input.verdictId,
    featureId: input.domain.handoffTargetResolver.featureId,
    evalSnapshotId: `eval-F192-session-recovery-${generatedAt.slice(0, 10)}`,
    generatedAt,
    findings,
  };
  return findings.length > 0
    ? base
    : {
        ...base,
        noFindingRecord: {
          reason: 'no structural or semantic session-recovery failure is present in the assessed window',
          evidence: 'session-recovery/assessed_total',
        },
      };
}

function finding(id: string, metric: string, value: number, layer: string, action: string, generatedAt: string) {
  return {
    id: `${id}-${generatedAt.slice(0, 10)}`,
    relatedFeature: 'F192',
    frictionSignal: {
      type: `session_recovery.${metric}`,
      severity: value >= 3 ? 'high' : value >= 2 ? 'medium' : 'low',
      confidence: value >= 3 ? 0.9 : 0.75,
      detectedAt: generatedAt,
    },
    attribution: {
      primaryLayer: layer,
      evidence: [{ type: 'counter', anchor: `session-recovery/${metric}`, excerpt: `${value} trial(s)` }],
    },
    proposedAction: [
      {
        action,
        target: 'F192/session-recovery',
        rationale: `Inspect the durable anchors for ${value} affected trial(s) before changing runtime behavior.`,
      },
    ],
    status: 'open',
  };
}

function sanitizeTrial(trial: SessionRecoveryTrial) {
  const assessment = trial.assessment;
  return {
    trialId: trial.trialId,
    source: sanitizeSessionRef(trial.source),
    ...(trial.target ? { target: sanitizeSessionRef(trial.target) } : {}),
    ...(trial.inferredTarget ? { inferredTarget: sanitizeSessionRef(trial.inferredTarget) } : {}),
    ...(trial.duplicateTargets
      ? {
          duplicateTargetCount: trial.duplicateTargets.length,
          duplicateTargets: trial.duplicateTargets.slice(0, MAX_RAW_DUPLICATE_TARGETS).map(sanitizeSessionRef),
          ...(trial.duplicateTargets.length > MAX_RAW_DUPLICATE_TARGETS ? { duplicateTargetsTruncated: true } : {}),
        }
      : {}),
    lineage: trial.lineage,
    transitionIntegrity: trial.transitionIntegrity,
    delivery: trial.delivery,
    structuralIssues: [...trial.structuralIssues],
    ...(trial.firstInvocationId ? { firstInvocationId: trial.firstInvocationId } : {}),
    ...(trial.firstMeaningfulEventRef ? { firstMeaningfulEventRef: trial.firstMeaningfulEventRef } : {}),
    ...(trial.terminalEventRef ? { terminalEventRef: trial.terminalEventRef } : {}),
    evidenceRefs: trial.evidenceRefs.slice(0, MAX_RAW_EVIDENCE_REFS),
    evidenceRefCount: trial.evidenceRefs.length,
    ...(trial.evidenceRefs.length > MAX_RAW_EVIDENCE_REFS ? { evidenceRefsTruncated: true } : {}),
    ...(assessment
      ? {
          assessment: {
            trialId: assessment.trialId,
            stateReconstruction: assessment.stateReconstruction,
            firstMeaningfulAction: assessment.firstMeaningfulAction,
            outcome: assessment.outcome,
            evidenceRefs: assessment.evidenceRefs.slice(0, MAX_RAW_EVIDENCE_REFS),
            rationaleSha256: sha256Text(assessment.rationale),
            rationaleLength: assessment.rationale.length,
          },
        }
      : {}),
  };
}

function sanitizeSessionRef(ref: SessionEvidenceRef) {
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

function sanitizeSelector(selector: SessionRecoverySourceSelector) {
  return {
    windowStartMs: selector.windowStartMs,
    windowEndMs: selector.windowEndMs,
    ...(selector.catId ? { catId: selector.catId } : {}),
    ...(selector.threadId ? { threadId: selector.threadId } : {}),
    ...(selector.limit !== undefined ? { limit: selector.limit } : {}),
  };
}

function assertGeneratorInput(input: GenerateSessionRecoveryLiveVerdictInput): void {
  if (!SAFE_VERDICT_ID_PATTERN.test(input.verdictId)) throw new Error('verdictId must be a safe slug');
  if (input.domain.domainId !== 'eval:session-recovery' || input.submittedPacket.domainId !== input.domain.domainId) {
    throw new Error('session_recovery_generator_wrong_domain');
  }
  if (
    input.submittedPacket.harnessUnderEval.featureId !== input.domain.handoffTargetResolver.featureId ||
    input.submittedPacket.harnessUnderEval.componentId !== 'session-recovery'
  ) {
    throw new Error('submitted_packet_evidence_mismatch: expected F192/session-recovery harness');
  }
  if (input.trials.length === 0) throw new Error('no_trials_in_window: empty session-recovery trial set');
  if (input.trials.some((trial) => !trial.assessment)) {
    throw new Error('missing_session_recovery_assessment: generator requires every trial to be assessed');
  }
}

function uniqueRefs(trials: SessionRecoveryTrial[], predicate: (ref: string) => boolean): string[] {
  return [...new Set(trials.flatMap((trial) => trial.evidenceRefs).filter(predicate))];
}

function keyInvocationEventRefs(trials: SessionRecoveryTrial[]): string[] {
  return [
    ...new Set(
      trials.flatMap((trial) => [
        ...(trial.firstInvocationId ? [`invocation:${trial.firstInvocationId}`] : []),
        ...(trial.firstMeaningfulEventRef ? [trial.firstMeaningfulEventRef] : []),
        ...(trial.terminalEventRef ? [trial.terminalEventRef] : []),
      ]),
    ),
  ];
}

function count(trials: SessionRecoveryTrial[], predicate: (trial: SessionRecoveryTrial) => boolean): number {
  return trials.filter(predicate).length;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
