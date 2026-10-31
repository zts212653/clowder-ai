import { canonicalizePathForGlobs, matchesAny } from '../capability-wakeup/eval-capability-wakeup-trials-support.js';
import type { PredicateDesignGateEvidence, SopEvalResult, SopRuleKind, SopSeverity } from './sop-predicate-types.js';
import { violation } from './sop-predicate-types.js';
import type { DesignGateReviewPacket, SopTrace } from './sop-trace-adapter.js';

export function evaluateDesignGateEvidence(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateDesignGateEvidence,
  trace: SopTrace,
): SopEvalResult {
  const candidateFiles = trace.changedFiles
    .map((path) => canonicalizePathForGlobs(path, [...predicate.consumerGlobs], []))
    .filter((path) => matchesAny(path, [...predicate.consumerGlobs]));
  if (candidateFiles.length === 0) return { ruleId, status: 'pass' };

  const diffContext = trace.diffContext;
  if (!diffContext) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'candidate route/consumer changes require exact diff context before Design Gate applicability can be proven',
      candidateFiles,
    );
  }

  const helperPattern = compilePattern(predicate.canonicalHelperPattern);
  if (!helperPattern) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'design_gate_evidence canonical helper pattern is invalid',
      candidateFiles,
    );
  }

  const candidateSet = new Set(candidateFiles);
  const eligibleFiles = diffContext.files
    .map((file) => ({
      ...file,
      path: canonicalizePathForGlobs(file.path, [...predicate.consumerGlobs], []),
    }))
    .filter((file) => candidateSet.has(file.path) && file.addedLines.some((line) => helperPattern.test(line)))
    .map((file) => file.path);
  if (eligibleFiles.length === 0) return { ruleId, status: 'pass' };

  const packet = trace.designGateReviewPacket;
  if (!packet) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'eligible consumer delta requires a design-gate review packet with concrete evidence',
      eligibleFiles,
    );
  }
  return evaluatePacket(ruleId, stageId, kind, severity, diffContext.headSha, packet, eligibleFiles);
}

function evaluatePacket(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  headSha: string,
  packet: DesignGateReviewPacket,
  eligibleFiles: readonly string[],
): SopEvalResult {
  if (packet.exactHeadSha !== headSha) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'design-gate review packet must bind the diff exact HEAD',
      eligibleFiles,
    );
  }

  const claimIds = packet.riskClaims.map((claim) => claim.id);
  if (new Set(claimIds).size !== claimIds.length) {
    return designGateViolation(ruleId, stageId, kind, severity, 'risk claim ids must be unique', eligibleFiles);
  }
  if (!packet.riskClaims.some((claim) => claim.kind === 'consumer_delta')) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'eligible route/helper diff requires an explicit consumer_delta risk claim',
      eligibleFiles,
    );
  }

  const knownClaimIds = new Set(claimIds);
  if (packet.targetedSelfCheckReceipts.some((receipt) => !knownClaimIds.has(receipt.claimId))) {
    return designGateViolation(
      ruleId,
      stageId,
      kind,
      severity,
      'targeted self-check receipt references an unknown risk claim',
      eligibleFiles,
    );
  }

  for (const claim of packet.riskClaims) {
    const missingEvidence = missingClaimEvidence(claim);
    if (missingEvidence) {
      return designGateViolation(
        ruleId,
        stageId,
        kind,
        severity,
        `risk claim "${claim.id}" requires concrete ${missingEvidence}`,
        eligibleFiles,
      );
    }
    const hasReceipt = packet.targetedSelfCheckReceipts.some(
      (receipt) =>
        receipt.claimId === claim.id &&
        receipt.headSha === headSha &&
        receipt.command === claim.claimGuard.command &&
        receipt.exitCode === 0,
    );
    if (!hasReceipt) {
      return designGateViolation(
        ruleId,
        stageId,
        kind,
        severity,
        `risk claim "${claim.id}" requires a successful targeted self-check receipt on the exact HEAD`,
        eligibleFiles,
      );
    }
  }

  return { ruleId, status: 'pass' };
}

function missingClaimEvidence(claim: DesignGateReviewPacket['riskClaims'][number]): string | null {
  if (!claim.id.trim()) return 'claim id';
  if (!claim.summary.trim()) return 'risk summary';
  if (!claim.canonicalSource.trim()) return 'canonical source';
  if (!claim.consumerEvidence.trim()) return 'consumer evidence';
  if (!claim.claimGuard.command.trim()) return 'claim guard command';
  if (!claim.claimGuard.redWhen.trim()) return 'claim guard red condition';
  return null;
}

function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

function designGateViolation(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  message: string,
  paths: readonly string[],
): SopEvalResult {
  return violation(
    ruleId,
    stageId,
    kind,
    severity,
    'design_gate_evidence',
    message,
    `eligible_consumer_files:[${[...new Set(paths)].join(',')}]`,
  );
}
