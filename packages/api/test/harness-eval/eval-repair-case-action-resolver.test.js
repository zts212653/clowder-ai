import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { EvalRepairCaseActionResolver } from '../../dist/infrastructure/harness-eval/eval-repair-case-action-resolver.js';
import {
  actionRef,
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
  const root = mkdtempSync(join(tmpdir(), 'f313-case-action-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('recovers a fresh action directly from the single durable supersession event', async () => {
    writeLifecycleRoot(root);
    const ctx = fixture();
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
    assert.equal(recovered.findingArtifactRef, 'artifact:f313:finding-1');
    assert.equal(recovered.repairTarget.version, targetVersion);
    assert.equal(
      (await ctx.eventLog.read(caseId)).filter((event) => event.type === 'case_ready_for_proposal').length,
      0,
    );
  });
});

function writeLifecycleRoot(root) {
  const bundleDir = join(root, 'bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
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
          artifactRef: 'artifact:f313:finding-1',
          artifactSha256: 'a'.repeat(64),
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
}
