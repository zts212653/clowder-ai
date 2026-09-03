import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ActionableFrictionCandidate, FrictionRollupReport, FrictionRollupSourceSelector } from '@cat-cafe/shared';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import type { GeneratedFindingArtifact, GeneratedVerdictChildArtifact } from '../publish-verdict/types.js';
import {
  isFrictionVerdictHandoffPacketV3,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import { formatFrictionLiveVerdictMarkdown } from './eval-friction-renderer.js';
import {
  buildFrictionAnalysisFinding,
  deriveFrictionChildVerdictId,
  digestFrictionAnalysisFinding,
  type FindingBindingV1,
  type FrictionAnalysisFindingInputV1,
  serializeFrictionAnalysisFinding,
} from './friction-finding-artifact.js';
import type { FrictionRepairTargetResolver } from './friction-repair-target-resolver.js';

export interface GenerateFrictionFindingChildrenInput {
  parentPacket: VerdictHandoffPacket;
  parentBundleDir: string;
  harnessFeedbackRoot: string;
  report: FrictionRollupReport;
  selector: FrictionRollupSourceSelector;
  analysisFindings: readonly FrictionAnalysisFindingInputV1[];
  targetResolver: FrictionRepairTargetResolver;
  ownerUserId: string;
}

export interface GeneratedFrictionFindingChildren {
  findingArtifacts: GeneratedFindingArtifact[];
  childArtifacts: GeneratedVerdictChildArtifact[];
}

export async function generateFrictionFindingChildren(
  input: GenerateFrictionFindingChildrenInput,
): Promise<GeneratedFrictionFindingChildren> {
  const judgments = validateFindingBijection(input.report, input.analysisFindings);
  const findingArtifacts: GeneratedFindingArtifact[] = [];
  const childArtifacts: GeneratedVerdictChildArtifact[] = [];

  for (const candidate of input.report.actionableCandidates) {
    const judgment = judgments.get(candidate.clusterId);
    if (!judgment) throw new Error(`invalid_analysis_findings: missing candidate ${candidate.clusterId}`);
    const resolution = await input.targetResolver.resolve({
      userId: input.ownerUserId,
      hint: judgment.repairTargetHint,
      resolvedAt: input.report.generatedAt,
    });
    const finding = buildFrictionAnalysisFinding({
      parentVerdictId: input.parentPacket.id,
      judgment,
      repairTargetResolution: resolution,
    });

    if (resolution.status === 'blocked') {
      const findingPath = join(input.parentBundleDir, 'findings', judgment.findingKey, 'finding.json');
      mkdirSync(join(input.parentBundleDir, 'findings', judgment.findingKey), { recursive: true });
      writeFileSync(findingPath, serializeFrictionAnalysisFinding(finding), 'utf8');
      findingArtifacts.push({
        candidateRef: judgment.candidateRef,
        findingKey: judgment.findingKey,
        artifactRef: repoRef(input.harnessFeedbackRoot, findingPath),
        artifactSha256: digestFrictionAnalysisFinding(finding),
        resolutionStatus: 'blocked',
        blockerReason: resolution.reason,
      });
      continue;
    }

    const verdictId = deriveFrictionChildVerdictId(input.parentPacket.id, judgment.findingKey);
    const bundleDir = join(input.harnessFeedbackRoot, 'bundles', verdictId);
    const rawDir = join(bundleDir, 'raw');
    const verdictPath = join(input.harnessFeedbackRoot, 'verdicts', `${verdictId}.md`);
    mkdirSync(rawDir, { recursive: true });
    const findingPath = join(bundleDir, 'finding.json');
    writeFileSync(findingPath, serializeFrictionAnalysisFinding(finding), 'utf8');
    const findingArtifactRef = repoRef(input.harnessFeedbackRoot, findingPath);
    const findingArtifactSha256 = digestFrictionAnalysisFinding(finding);
    const findingBinding: FindingBindingV1 = {
      artifactRef: findingArtifactRef,
      artifactSha256: findingArtifactSha256,
      analysisDisposition: judgment.analysisDisposition,
      approvalRequirement: judgment.approvalRequirement,
    };

    const candidatePath = join(rawDir, 'candidate.json');
    writeJson(candidatePath, { selector: input.selector, candidate });
    writeChildBundle({
      bundleDir,
      verdictId,
      generatedAt: input.parentPacket.createdAt,
      parentPacket: input.parentPacket,
      candidate,
      judgment,
      targetFeatureId: resolution.target.featureId,
      selector: input.selector,
      candidatePath,
      findingPath,
    });
    const resolvedBundle = resolveA2aEvidenceBundle({ bundleDir, verdictId });
    const packet = parseVerdictHandoffPacket({
      ...input.parentPacket,
      id: verdictId,
      findingKey: judgment.findingKey,
      findingBinding,
      repairTarget: resolution.target,
      phenomenon: candidate.representative,
      evidencePacket: {
        ...input.parentPacket.evidencePacket,
        snapshotRefs: [resolvedBundle.snapshotRef],
        attributionRefs: resolvedBundle.attributionRefs,
        sampleTraceRefs: judgment.sourceSignalRefs,
      },
      rootCauseHypothesis: {
        summary: judgment.rationale,
        confidence: judgment.uncertainty,
        alternatives: input.parentPacket.rootCauseHypothesis.alternatives,
      },
      verdict: childVerdict(judgment),
      ownerAsk: {
        targetFeatureId: resolution.target.featureId,
        targetOwnerCatId: resolution.target.ownerCatId,
        requestedAction: judgment.rationale,
      },
      ...(judgment.interventionKind === 'delete_sunset'
        ? { governance: { cvoAcceptRequired: true } }
        : { governance: input.parentPacket.governance }),
    });
    if (!isFrictionVerdictHandoffPacketV3(packet)) {
      throw new Error(`invalid_analysis_findings: failed to construct child packet for ${judgment.findingKey}`);
    }
    writeFileSync(
      verdictPath,
      formatFrictionLiveVerdictMarkdown(verdictId, packet, resolvedBundle.snapshotRef),
      'utf8',
    );
    findingArtifacts.push({
      candidateRef: judgment.candidateRef,
      findingKey: judgment.findingKey,
      artifactRef: findingArtifactRef,
      artifactSha256: findingArtifactSha256,
      resolutionStatus: 'resolved',
    });
    childArtifacts.push({
      verdictId,
      findingKey: judgment.findingKey,
      verdictPath,
      bundleDir,
      findingArtifactRef,
      findingArtifactSha256,
      packet,
    });
  }
  return { findingArtifacts, childArtifacts };
}

function validateFindingBijection(
  report: FrictionRollupReport,
  findings: readonly FrictionAnalysisFindingInputV1[],
): Map<string, FrictionAnalysisFindingInputV1> {
  const expected = new Set(report.actionableCandidates.map((candidate) => candidate.clusterId));
  const actual = new Set(findings.map((finding) => finding.candidateRef));
  const missing = [...expected].filter((candidateRef) => !actual.has(candidateRef));
  const unknown = [...actual].filter((candidateRef) => !expected.has(candidateRef));
  if (missing.length > 0 || unknown.length > 0 || findings.length !== expected.size) {
    throw new Error(
      `invalid_analysis_findings: candidateRefs must biject actionable candidates; missing=[${missing.join(',')}] unknown=[${unknown.join(',')}]`,
    );
  }
  return new Map(findings.map((finding) => [finding.candidateRef, finding]));
}

function writeChildBundle(input: {
  bundleDir: string;
  verdictId: string;
  generatedAt: string;
  parentPacket: VerdictHandoffPacket;
  candidate: ActionableFrictionCandidate;
  judgment: FrictionAnalysisFindingInputV1;
  targetFeatureId: string;
  selector: FrictionRollupSourceSelector;
  candidatePath: string;
  findingPath: string;
}): void {
  const metricKey = `cluster_${input.candidate.clusterId}`;
  const evalSnapshotId = `eval-F245-${input.verdictId}`;
  writeJson(join(input.bundleDir, 'snapshot.json'), {
    verdictId: input.verdictId,
    evalSnapshotId,
    featureId: input.parentPacket.harnessUnderEval.featureId,
    generatedAt: input.generatedAt,
    window: {
      startMs: input.selector.windowStartMs,
      endMs: input.selector.windowEndMs,
      durationHours: (input.selector.windowEndMs - input.selector.windowStartMs) / 3_600_000,
    },
    components: [
      {
        id: 'friction-rollup',
        name: 'friction finding child',
        confidence: input.judgment.uncertainty,
        activationCounts: {},
        frictionCounts: { [metricKey]: input.candidate.count },
      },
    ],
  });
  writeJson(join(input.bundleDir, 'attribution.json'), {
    verdictId: input.verdictId,
    featureId: input.parentPacket.harnessUnderEval.featureId,
    evalSnapshotId,
    generatedAt: input.generatedAt,
    findings: [
      {
        id: `FR-${input.judgment.findingKey}`,
        relatedFeature: input.parentPacket.harnessUnderEval.featureId,
        frictionSignal: {
          type: `friction.${metricKey}`,
          severity: input.candidate.severity,
          confidence: input.judgment.uncertainty === 'low' ? 0.9 : input.judgment.uncertainty === 'medium' ? 0.7 : 0.5,
          detectedAt: input.generatedAt,
        },
        attribution: {
          primaryLayer: 'analysis_finding',
          evidence: [
            {
              type: 'counter',
              anchor: `friction-rollup/${metricKey}`,
              excerpt: `${input.candidate.representative} count=${input.candidate.count}`,
            },
          ],
        },
        proposedAction: [
          {
            action: input.judgment.analysisDisposition,
            target: input.targetFeatureId,
            rationale: input.judgment.rationale,
          },
        ],
        status: 'open',
      },
    ],
  });
  writeJson(join(input.bundleDir, 'provenance.json'), {
    verdictId: input.verdictId,
    rawInputs: [input.candidatePath, input.findingPath].map((path) => ({
      path: repoRefFromBundle(input.bundleDir, path),
      sha256: sha256File(path),
    })),
    generatedAt: input.generatedAt,
    generator: { name: 'eval-friction-finding-child', version: '1' },
    sanitizeRulesVersion: 'f313-friction-finding-v1',
  });
}

function childVerdict(finding: FrictionAnalysisFindingInputV1): VerdictHandoffPacket['verdict'] {
  if (finding.analysisDisposition !== 'repair') return 'keep_observe';
  if (!finding.interventionKind) throw new Error('invalid_analysis_findings: repair interventionKind unavailable');
  return finding.interventionKind;
}

function repoRef(harnessFeedbackRoot: string, path: string): string {
  return relative(join(harnessFeedbackRoot, '..', '..'), path).replace(/\\/g, '/');
}

function repoRefFromBundle(bundleDir: string, path: string): string {
  return relative(join(bundleDir, '..', '..', '..', '..'), path).replace(/\\/g, '/');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
