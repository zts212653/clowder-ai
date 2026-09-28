import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { stringify } from 'yaml';
import {
  loadRequestReviewEvalRepairOwnerBinding,
  REQUEST_REVIEW_EVAL_REPAIR_OWNER_BINDING_PATH,
} from '../dist/infrastructure/capability-evolution/change/request-review-eval-repair-owner-binding.js';
import { RequestReviewLineageBindingResolver } from '../dist/infrastructure/capability-evolution/change/request-review-lineage-binding-resolver.js';

const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c',
};
const cycleRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
};
const interventionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
const assetVersionRef = {
  ...interventionRef,
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};

function action(caseActionRef) {
  return {
    caseId: `case-${caseActionRef}`,
    verdictId: `verdict-${caseActionRef}`,
    domainId: 'eval:capability-evolution',
    findingKey: caseActionRef,
    analysisDisposition: 'repair',
    approvalRequirement: { kind: 'required', reason: 'repair' },
    findingArtifactRef: `finding:${caseActionRef}`,
    repairTarget: {
      featureId: 'F100',
      componentId: interventionRef.ownerStateRef,
      version: assetVersionRef.version,
    },
    expectedChange: 'change the request-review accepted-source anchor',
    costAndRollback: 'revert the semantic anchor',
    withdrawalCondition: 'target drift',
  };
}

describe('request-review exact Program lineage binding', () => {
  it('selects only the caseActionRef explicitly bound to this Program and cycle', async () => {
    const actions = new Map([
      ['case-action:f266:bound', action('bound')],
      ['case-action:f266:other-program', action('other-program')],
    ]);
    const resolver = new RequestReviewLineageBindingResolver({
      readBindings: async () => [
        {
          programRef,
          cycleRef,
          interventionRef,
          assetVersionRef,
          caseActionRef: 'case-action:f266:bound',
        },
        {
          programRef: { ...programRef, ownerStateRef: 'evolution-program:other' },
          cycleRef: { ...cycleRef, ownerStateRef: 'evolution-cycle:evolution-program:other:1' },
          interventionRef,
          assetVersionRef,
          caseActionRef: 'case-action:f266:other-program',
        },
      ],
      resolveCaseAction: async (ref) => actions.get(ref) ?? null,
      versionReader: { currentVersionRef: async () => assetVersionRef },
    });
    const lineage = { programRef, cycleRef, interventionRef };

    assert.deepEqual(await resolver.resolve(lineage), {
      status: 'resolved',
      caseActionRef: 'case-action:f266:bound',
    });
    assert.deepEqual(
      await resolver.resolve({
        ...lineage,
        cycleRef: {
          ...cycleRef,
          ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:2',
        },
      }),
      {
        status: 'blocked',
        reason: 'lineage_missing',
      },
    );
  });

  it('binds owner facts to the exact request-review action and rejects foreign scope', async () => {
    const boundRef = 'case-action:f266:bound';
    const unrelatedRef = 'case-action:f266:unrelated-target';
    const actions = new Map([
      [boundRef, action('bound')],
      [
        unrelatedRef,
        {
          ...action('unrelated-target'),
          repairTarget: {
            featureId: 'F188',
            componentId: 'memory:evidence-reader',
            version: assetVersionRef.version,
          },
        },
      ],
    ]);
    const resolver = new RequestReviewLineageBindingResolver({
      readBindings: async () => [
        { programRef, cycleRef, interventionRef, assetVersionRef, caseActionRef: boundRef },
        { programRef, cycleRef, interventionRef, assetVersionRef, caseActionRef: unrelatedRef },
      ],
      resolveCaseAction: async (ref) => actions.get(ref) ?? null,
      versionReader: { currentVersionRef: async () => assetVersionRef },
    });
    const proposal = (caseActionRef, overrides = {}) => ({
      caseActionRef,
      verdictId: actions.get(caseActionRef).verdictId,
      requestSnapshot: { targetVersionRef: assetVersionRef },
      ownerLineage: { programRef, cycleRef, interventionRef },
      ...overrides,
    });

    assert.deepEqual(
      await resolver.resolveProposalScope({
        caseId: actions.get(boundRef).caseId,
        proposal: proposal(boundRef),
      }),
      { status: 'resolved', caseActionRef: boundRef },
    );
    assert.deepEqual(
      await resolver.resolveProposalScope({
        caseId: actions.get(unrelatedRef).caseId,
        proposal: proposal(unrelatedRef),
      }),
      { status: 'blocked', reason: 'lineage_mismatch' },
    );
    assert.deepEqual(
      await resolver.resolveProposalScope({
        caseId: actions.get(boundRef).caseId,
        proposal: proposal(boundRef, {
          ownerLineage: {
            programRef: { ...programRef, ownerStateRef: 'evolution-program:foreign' },
            cycleRef: { ...cycleRef, ownerStateRef: 'evolution-cycle:evolution-program:foreign:1' },
            interventionRef,
          },
        }),
      }),
      { status: 'blocked', reason: 'lineage_mismatch' },
    );
  });

  it('loads an explicitly empty binding without inventing F267/F266 lineage', async (t) => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'request-review-empty-binding-'));
    t.after(() => rm(repoRoot, { recursive: true, force: true }));
    const path = join(repoRoot, REQUEST_REVIEW_EVAL_REPAIR_OWNER_BINDING_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      stringify({
        kind: 'f100-request-review-eval-repair-owner-binding',
        schemaVersion: 1,
        programRef,
        targetRef: interventionRef,
        lineageBindings: [],
        truthBoundary: ['Synthetic fixture with no natural lineage.'],
      }),
    );
    assert.deepEqual(await loadRequestReviewEvalRepairOwnerBinding(repoRoot), { lineageBindings: [] });
  });
});
