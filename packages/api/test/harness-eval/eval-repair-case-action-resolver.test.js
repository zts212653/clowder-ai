import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { EvalRepairCaseActionResolver } from '../../dist/infrastructure/harness-eval/eval-repair-case-action-resolver.js';
import {
  actionRef,
  caseAction,
  caseId,
  dispatchRef,
  fixture,
  ownerRef,
  principal,
  ref,
  targetVersion,
  targetVersionRef,
  verdictId,
} from './eval-repair-approval-fixtures.js';

describe('F313 linked fresh case/action resolution', () => {
  const temp = mkdtempSync(join(tmpdir(), 'f313-case-action-'));
  const root = join(temp, 'docs', 'harness-feedback');
  after(() => rmSync(temp, { recursive: true, force: true }));

  it('recovers a fresh action directly from the single durable supersession event', async () => {
    const source = writeLifecycleRoot(root);
    const ctx = fixture();
    ctx.actions.set(actionRef, caseAction({ findingArtifactRef: source.artifactRef }));
    const original = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
    ctx.setOwner({
      status: 'resolved',
      ownerRef,
      ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
      targetVersionRef,
      dispatchRef,
    });
    const superseded = await ctx.service.propose({
      caseActionRef: actionRef,
      clientMessageId: 'client-2',
      principal,
    });
    assert.equal(superseded.status, 'superseded');

    const resolver = new EvalRepairCaseActionResolver(root, ctx.eventLog);
    const recovered = await resolver.resolve(superseded.freshCaseActionRef);

    assert.equal(recovered.supersedesProposalId, original.proposalId);
    assert.equal(recovered.findingArtifactRef, source.artifactRef);
    assert.equal(recovered.repairTarget.version, targetVersion);
    assert.deepEqual(recovered.decisionExplanation, source.decisionExplanation);
    assert.equal(recovered.expectedChange, source.decisionExplanation.expectedChange);
    assert.equal(recovered.costAndRollback, source.decisionExplanation.costAndRollback);
    assert.equal(
      (await ctx.eventLog.read(caseId)).filter((event) => event.type === 'case_ready_for_proposal').length,
      0,
    );
  });
});

function writeLifecycleRoot(root) {
  const bundleDir = join(root, 'bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  const artifactRef = `docs/harness-feedback/bundles/${verdictId}/finding.json`;
  const decisionExplanation = {
    schemaVersion: 1,
    expectedChange: 'Repair exact evidence-reader drilldown behavior',
    beforeSummary: 'Repo-relative drill refs fail from package working directories.',
    afterSummary: 'The same exact ref opens from repository root and package working directories.',
    changeSetSummary: 'Resolve exact drill refs from the repository root without rewriting stored refs.',
    attributionBoundary: 'This proposal addresses cwd resolution only; malformed source refs remain invalid.',
    independentVerification: 'Reopen the same ref from both working directories on the exact candidate.',
    rejectedCandidates: ['Persist machine-local absolute paths in source refs.'],
    costAndRollback: 'One reversible PR; revert the merge commit',
  };
  const finding = {
    schemaVersion: 1,
    parentVerdictId: 'f313-parent',
    domainId: 'eval:friction',
    candidateRef: 'candidate:evidence-reader',
    findingKey: 'evidence-reader',
    analysisDisposition: 'repair',
    approvalRequirement: { kind: 'required', reason: 'repair' },
    interventionKind: 'fix',
    rationale: 'The reader resolves repo-relative drill refs against the package cwd.',
    uncertainty: 'medium',
    falsifier: {
      condition: 'The same ref opens from both repo root and package cwd.',
      evidenceRef: 'measurement:f313/drilldown-path/falsifier',
    },
    withdrawalCondition: 'Withdraw if owner truth or exact target changes',
    measurementResultRef: 'measurement:f267/f313/evidence-reader',
    sourceSignalRefs: ['source-message:evidence-reader'],
    decisionExplanation,
    repairTargetResolution: {
      status: 'resolved',
      target: {
        featureId: 'F188',
        componentId: 'evidence-reader',
        ownerCatId: 'codex-sol',
        version: targetVersion,
        resolutionRef: 'feature-thread-owner:v1:F188:thread-f188:codex-sol',
        resolvedAt: '2026-09-02T00:00:00.000Z',
      },
    },
  };
  const serializedFinding = `${JSON.stringify(finding, null, 2)}\n`;
  writeFileSync(join(bundleDir, 'finding.json'), serializedFinding);
  const artifactSha256 = createHash('sha256').update(serializedFinding, 'utf8').digest('hex');
  writeFileSync(
    join(bundleDir, 'lifecycle-root.json'),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        caseId,
        verdictId,
        domainId: 'eval:friction',
        findingKey: 'evidence-reader',
        createdAt: '2026-09-02T00:00:00.000Z',
        verdict: 'fix',
        harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
        ownerAsk: {
          targetFeatureId: 'F188',
          targetOwnerCatId: 'codex-sol',
          requestedAction: 'Repair exact evidence-reader drilldown behavior',
        },
        acceptanceReevalPlan: {
          nextEvalAt: '2026-09-05T00:00:00.000Z',
          closureCondition: 'The exact repair target passes re-evaluation.',
        },
        findingBinding: {
          artifactRef,
          artifactSha256,
          analysisDisposition: 'repair',
          approvalRequirement: { kind: 'required', reason: 'repair' },
        },
        repairTarget: {
          featureId: 'F188',
          componentId: 'evidence-reader',
          ownerCatId: 'codex-sol',
          version: targetVersion,
          resolutionRef: 'feature-thread-owner:v1:F188:thread-f188:codex-sol',
          resolvedAt: '2026-09-02T00:00:00.000Z',
        },
      },
      null,
      2,
    )}\n`,
  );
  return { artifactRef, decisionExplanation };
}
