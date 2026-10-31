import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digestFrictionAnalysisFinding,
  serializeFrictionAnalysisFinding,
} from '../../../dist/infrastructure/harness-eval/friction/friction-finding-artifact.js';
import { PawFeelSourceCaseActionResolver } from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/continuation/source-case-action-resolver.js';
import { deriveEvalCaseId } from '../../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';

const created = [];

export async function cleanupSourceCaseFixtures() {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export const sourceSignalRef = {
  ownerFeatureId: 'F278',
  ownerStateRef: 'paw-feel-signal:signal-1',
  version: `${'a'.repeat(64)}:0`,
};

export const projection = {
  signalId: 'signal-1',
  sourceMessageId: 'message-1',
  sourceThreadId: 'thread-source',
  sourceCatId: 'codex-sol',
  markerDigest: 'a'.repeat(64),
  sameDigestOrdinal: 0,
  markerIndex: 0,
  state: 'seen',
  sequence: 2,
  discoveredAt: '2026-09-01T00:00:00.000Z',
  lastTransitionAt: '2026-09-01T00:00:01.000Z',
  backfilled: false,
  captureMethod: 'typed',
  captureAssessment: 'confirmed',
};

const verifiedSource = {
  sourceSignalRef,
  sourceToolRef: { ownerFeatureId: 'F167', ownerStateRef: 'mcp-tool:cat_cafe_hold_ball' },
  markerDigest: 'a'.repeat(64),
  sameDigestOrdinal: 0,
  markerIndex: 0,
};

function finding(findingKey) {
  return {
    schemaVersion: 1,
    parentVerdictId: 'parent-verdict',
    domainId: 'eval:friction',
    candidateRef: `candidate-${findingKey}`,
    findingKey,
    analysisDisposition: 'repair',
    approvalRequirement: { kind: 'required', reason: 'repair' },
    interventionKind: 'fix',
    rationale: 'Canonical source needs an authority-expanding repair.',
    uncertainty: 'low',
    falsifier: { condition: 'The source no longer reproduces.', evidenceRef: 'measurement:falsifier' },
    withdrawalCondition: 'Withdraw if the source is invalidated.',
    measurementResultRef: 'measurement:result',
    sourceSignalRefs: ['source-message:message-1#0'],
    repairTargetResolution: {
      status: 'resolved',
      target: {
        featureId: 'F167',
        ownerCatId: 'opus',
        version: `repair-target-v1-${createHash('sha256').update(findingKey).digest('hex')}`,
        resolutionRef: `feature-thread-owner:v1:F167:${findingKey}`,
        resolvedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  };
}

export async function writeCase(root, findingKey, verdictId, options = {}) {
  const value = finding(findingKey);
  const bundle = join(root, 'bundles', verdictId);
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'finding.json'), serializeFrictionAnalysisFinding(value));
  const artifactRef = `docs/harness-feedback/bundles/${verdictId}/finding.json`;
  const caseId = deriveEvalCaseId('eval:friction', findingKey);
  await writeFile(
    join(bundle, 'lifecycle-root.json'),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        caseId,
        verdictId,
        findingKey,
        domainId: options.rootDomainId ?? 'eval:friction',
        createdAt: '2026-09-01T00:00:00.000Z',
        verdict: 'fix',
        harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction' },
        ownerAsk: {
          targetFeatureId: options.rootTarget?.featureId ?? 'F167',
          targetOwnerCatId: options.rootTarget?.ownerCatId ?? 'opus',
          requestedAction: 'repair it',
        },
        acceptanceReevalPlan: {
          nextEvalAt: '2026-09-04T00:00:00.000Z',
          closureCondition: 'verified outcome',
        },
        findingBinding: {
          artifactRef,
          artifactSha256: digestFrictionAnalysisFinding(value),
          analysisDisposition: 'repair',
          approvalRequirement: { kind: 'required', reason: 'repair' },
        },
        repairTarget: options.rootTarget ?? value.repairTargetResolution.target,
      },
      null,
      2,
    )}\n`,
  );
  return { caseId, verdictId, artifactRef };
}

function appendOutcome(caseEvents, value, outcome) {
  caseEvents.push({
    type: 'repair_outcome_recorded',
    caseId: value.caseId,
    verdictId: value.verdictId,
    occurredAt: '2026-09-07T00:00:00.000Z',
    proposalId: `proposal:${value.verdictId}`,
    caseActionRef: `case-action:${value.verdictId}`,
    approvalRef: { ownerFeatureId: 'F246', ownerStateRef: `approval:${value.verdictId}` },
    outcome,
    interventionReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: 'intervention:one' },
    outcomeReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: 'outcome:one' },
    reevaluationRef: { ownerFeatureId: 'F267', ownerStateRef: 'reevaluation:one' },
    freshnessProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'freshness:one' },
  });
}

function appendApproval(caseEvents, value) {
  caseEvents.push(
    {
      type: 'approval_proposed',
      caseId: value.caseId,
      verdictId: value.verdictId,
      caseActionRef: `case-action:${value.verdictId}`,
      proposalId: `proposal:${value.verdictId}`,
    },
    {
      type: 'approval_decided',
      caseId: value.caseId,
      verdictId: value.verdictId,
      proposalId: `proposal:${value.verdictId}`,
      resolution: 'accepted',
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: `approval:${value.verdictId}` },
    },
  );
}

function appendJourney(caseEvents, value) {
  caseEvents.push(
    {
      type: 'approval_materialized',
      caseId: value.caseId,
      verdictId: value.verdictId,
      proposalId: `proposal:${value.verdictId}`,
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: `approval:${value.verdictId}` },
      taskRef: { ownerFeatureId: 'F310', ownerStateRef: `task:item:${value.verdictId}` },
      leaseRef: { ownerFeatureId: 'F167', ownerStateRef: `action-lease:${value.verdictId}` },
      custodyReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: `custody:${value.verdictId}` },
    },
    {
      type: 'repair_intervention_changed',
      caseId: value.caseId,
      verdictId: value.verdictId,
      proposalId: `proposal:${value.verdictId}`,
      interventionReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: `intervention:${value.verdictId}` },
      assetVersionRef: {
        ownerFeatureId: 'F167',
        ownerStateRef: `asset:${value.verdictId}`,
        version: 'v2',
        assetKind: 'mcp_tool',
        assetId: 'cat_cafe_hold_ball',
      },
      mainCommitSha: 'a'.repeat(40),
      loadedRuntimeRef: { ownerFeatureId: 'F167', ownerStateRef: `loaded:${value.verdictId}` },
    },
    {
      type: 'repair_outcome_recorded',
      caseId: value.caseId,
      verdictId: value.verdictId,
      occurredAt: '2026-09-07T00:00:00.000Z',
      proposalId: `proposal:${value.verdictId}`,
      caseActionRef: `case-action:${value.verdictId}`,
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: `approval:${value.verdictId}` },
      outcome: 'effective_keep',
      interventionReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: `intervention:${value.verdictId}` },
      outcomeReceiptRef: { ownerFeatureId: 'F167', ownerStateRef: `outcome:${value.verdictId}` },
      reevaluationRef: { ownerFeatureId: 'F267', ownerStateRef: `reevaluation:${value.verdictId}` },
      freshnessProofRef: { ownerFeatureId: 'F267', ownerStateRef: `freshness:${value.verdictId}` },
      loadedRuntimeRef: { ownerFeatureId: 'F167', ownerStateRef: `loaded:${value.verdictId}` },
    },
  );
}

export async function harnessState(caseSpecs = []) {
  const repo = await mkdtemp(join(tmpdir(), 'f313-source-case-'));
  created.push(repo);
  const root = join(repo, 'docs', 'harness-feedback');
  await mkdir(join(root, 'bundles'), { recursive: true });
  const events = new Map();
  for (const spec of caseSpecs) {
    const value = await writeCase(root, spec.findingKey, spec.verdictId, spec);
    const caseEvents =
      spec.ready === false
        ? []
        : [
            {
              type: 'case_ready_for_proposal',
              caseId: value.caseId,
              verdictId: value.verdictId,
              caseActionRef: `case-action:${value.verdictId}`,
              findingArtifactRef: value.artifactRef,
              occurredAt: '2026-09-01T00:00:01.000Z',
            },
          ];
    if (spec.outcome) appendOutcome(caseEvents, value, spec.outcome);
    if (spec.accepted || spec.journey) appendApproval(caseEvents, value);
    if (spec.journey) appendJourney(caseEvents, value);
    events.set(value.caseId, caseEvents);
  }
  const resolver = new PawFeelSourceCaseActionResolver({
    harnessFeedbackRoot: root,
    eventLog: {
      async listSubjectIds() {
        return [...events.keys()];
      },
      async read(caseId) {
        return events.get(caseId) ?? [];
      },
    },
    sourceVerifier: {
      async verifyIdentity() {
        return verifiedSource;
      },
    },
  });
  return { events, resolver, root };
}

export async function harness(caseSpecs = []) {
  return (await harnessState(caseSpecs)).resolver;
}
