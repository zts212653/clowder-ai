import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cycleRef,
  exactBase,
  interventionRef,
  makeHarness,
  programRef,
  shaA,
  showState,
  targetVersionRef,
} from './helpers/microduck-owner-harness.js';

describe('F311 Microduck generated show manifest', () => {
  it('accepts the atomic T1 evaluation receipt shape without invented split or config refs', async () => {
    const state = showState({ phase: 'approval_ready' });
    const evaluationRef = state.baseline.evaluationRef;
    const candidateSubjects = ['push-range', 'spawn-tilt', 'upright-weight'];
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          return state;
        },
      },
    });
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 11 });

    assert.equal(manifest.tier, 'A');
    assert.equal(manifest.actionState, 'enabled');
    assert.deepEqual(
      manifest.candidates.map(({ subjectId, evaluationRef: candidateEvaluationRef, recipeSha256 }) => ({
        subjectId,
        evaluationRef: candidateEvaluationRef,
        recipeSha256,
      })),
      candidateSubjects.map((subjectId, index) => ({
        subjectId,
        evaluationRef,
        recipeSha256: String(index + 3).repeat(64),
      })),
    );
  });

  it('fails closed when atomic owner evidence drifts', async () => {
    const corruptions = [
      (state) => {
        [state.candidates[0].subjectId, state.candidates[1].subjectId] = [
          state.candidates[1].subjectId,
          state.candidates[0].subjectId,
        ];
      },
      (state) => {
        state.candidates[1].evaluationRef = {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `evaluation:sha256:${'9'.repeat(64)}`,
        };
      },
      (state) => {
        state.candidates[2].recipeSha256 = 'A'.repeat(64);
      },
      (state) => {
        const policyRevision = {
          ...state.baseline.policyRevision,
          ownerStateRef: state.baseline.policyRevision.ownerStateRef.replace(/^hf-space:/u, 'hf-model:'),
        };
        state.baseline.policyRevision = policyRevision;
        state.rollbackRevision = { ...policyRevision };
      },
      (state) => {
        const policyStateRef = state.candidates[1].policyRevision.ownerStateRef.replace(/^hf-model:/u, 'hf-space:');
        state.candidates[1].policyRevision = {
          ...state.candidates[1].policyRevision,
          ownerStateRef: policyStateRef,
        };
        state.candidates[1].onnxArtifactRef = {
          ...state.candidates[1].onnxArtifactRef,
          ownerStateRef: policyStateRef,
        };
      },
      (state) => {
        state.candidates[2].onnxArtifactRef = {
          ...state.candidates[2].onnxArtifactRef,
          ownerStateRef: state.candidates[2].onnxArtifactRef.ownerStateRef.replace(
            '#exported/policy.onnx',
            '#exported/other.onnx',
          ),
        };
      },
      (state) => {
        const revision = 'e'.repeat(40);
        state.rollbackRevision = {
          ...state.baseline.policyRevision,
          ownerStateRef: state.baseline.policyRevision.ownerStateRef.replace(/@[a-f0-9]{40}#/u, `@${revision}#`),
          version: revision,
        };
      },
      (state) => {
        state.candidates[1].checkpointRef = {
          ...state.candidates[1].checkpointRef,
          ownerStateRef: state.candidates[1].checkpointRef.ownerStateRef.replace(/^hf-model:/u, 'hf-space:'),
        };
      },
      (state) => {
        const revision = 'e'.repeat(40);
        state.candidateRevision = {
          ...state.candidateRevision,
          ownerStateRef: state.candidateRevision.ownerStateRef.replace(/@[a-f0-9]{40}#/u, `@${revision}#`),
          version: revision,
        };
      },
    ];

    const results = [];
    for (const corrupt of corruptions) {
      const state = showState({ phase: 'approval_ready' });
      corrupt(state);
      const { adapter } = makeHarness({
        owner: {
          async resolveShowState() {
            return state;
          },
        },
      });

      const manifest = await adapter.manifest({ ...exactBase(), programSequence: 11 });

      results.push({ tier: manifest.tier, actionState: manifest.actionState, hasAction: 'action' in manifest });
    }

    assert.deepEqual(
      results,
      Array.from({ length: corruptions.length }, () => ({
        tier: 'B',
        actionState: 'disabled',
        hasAction: false,
      })),
    );
  });

  it('exposes the canonical F246 action only while exact owner truth is approval-ready', async () => {
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          return showState({ phase: 'approval_ready' });
        },
      },
    });
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 11 });

    assert.equal(manifest.manifestVersion, 'f311-microduck-show-v1');
    assert.equal(manifest.phase, 'approval_ready');
    assert.equal(manifest.actionState, 'enabled');
    assert.equal(manifest.action.method, 'POST');
    assert.match(manifest.action.approvalUrl, /^\/api\/eval-repair-proposals\/[^/]+\/approve$/u);
    assert.deepEqual(manifest.action.body, { reasonCode: 'accepted_as_proposed' });
    assert.equal(manifest.holdoutProof.optimizerExposed, false);
    assert.equal('approvalRef' in manifest, false);
    assert.equal('deployedRevision' in manifest, false);
    assert.equal('freshOutcomeRef' in manifest, false);
  });

  it('fails closed for borrowed, closed, or stale canonical F266 proposals before exposing approval', async () => {
    const pending = {
      status: 'pending',
      proposalRef: showState({ phase: 'approval_ready' }).approvalProposalRef,
      programRef,
      cycleRef,
      interventionRef,
      targetVersionRef,
    };
    const resolutions = [
      { ...pending, programRef: { ...programRef, ownerStateRef: 'evolution-program:borrowed' } },
      { status: 'blocked', code: 'approval_missing' },
      { ...pending, cycleRef: { ...cycleRef, ownerStateRef: `${cycleRef.ownerStateRef}:stale` } },
    ];

    for (const resolution of resolutions) {
      const { adapter } = makeHarness({
        owner: {
          async resolveShowState() {
            return showState({ phase: 'approval_ready' });
          },
        },
        proposalResolver: {
          async resolve() {
            return resolution;
          },
        },
      });
      const manifest = await adapter.manifest({ ...exactBase(), programSequence: 11 });

      assert.equal(manifest.tier, 'B');
      assert.equal(manifest.actionState, 'disabled');
      assert.equal('action' in manifest, false);
    }
  });

  it('projects only resolver-declared scene media through canonical same-origin API URLs', async () => {
    const captureRef = showState().baseline.captureRef;
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          return showState({
            sceneMedia: [{ sceneIndex: 1, source: 'real_capture', captureRef, kind: 'image' }],
          });
        },
      },
    });
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });

    assert.deepEqual(manifest.sceneMedia, [
      {
        sceneIndex: 1,
        source: 'real_capture',
        captureRef,
        kind: 'image',
        assetUrl: `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-media/1`,
      },
    ]);
  });

  it('derives a completed read-only manifest without reopening approval', async () => {
    const { adapter } = makeHarness();
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });

    assert.equal(manifest.manifestVersion, 'f311-microduck-show-v1');
    assert.equal(manifest.tier, 'A');
    assert.equal(manifest.phase, 'kept');
    assert.equal(manifest.actionState, 'disabled');
    assert.equal('action' in manifest, false);
    assert.equal(manifest.programRef.ownerStateRef, programRef.ownerStateRef);
    assert.equal(manifest.candidates.length, 3);
    assert.equal(manifest.evaluatedArtifactHash, shaA);
    assert.equal(manifest.deployedArtifactHash, shaA);
    assert.equal(manifest.generatedAt, '2026-09-04T01:10:00.000Z');
    assert.equal(JSON.stringify(manifest).includes('secret'), false);
  });

  it('keeps applying, verifying and rolled-back phases read-only', async () => {
    for (const phase of ['applying', 'verifying', 'rolled_back']) {
      const { adapter } = makeHarness({
        owner: {
          async resolveShowState() {
            return showState({ phase });
          },
        },
      });
      const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });

      assert.equal(manifest.phase, phase);
      assert.equal(manifest.actionState, 'disabled');
      assert.equal('action' in manifest, false);
    }
  });

  it('refuses a completed phase when canonical F246 resolves a different exact target', async () => {
    const { adapter } = makeHarness({
      approvalResolver: {
        async resolve() {
          return {
            status: 'approved',
            approvalRef: showState().approvalRef,
            proposalRef: showState().approvalProposalRef,
            programRef,
            cycleRef,
            interventionRef,
            targetVersionRef: { ...showState().targetRevision, version: '4'.repeat(40) },
          };
        },
      },
    });

    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });
    assert.equal(manifest.tier, 'B');
    assert.equal(manifest.phase, 'blocked');
    assert.equal(manifest.actionState, 'disabled');
  });

  it('downgrades drifted deployment truth instead of projecting a successful phase', async () => {
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          return showState({ phase: 'verifying', deployedArtifactSha256: 'b'.repeat(64) });
        },
      },
    });
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });

    assert.equal(manifest.tier, 'B');
    assert.equal(manifest.phase, 'blocked');
    assert.deepEqual(manifest.blockers, [{ code: 'show_truth_incomplete' }]);
  });

  it('fails closed instead of projecting approval when holdout exposure proof is absent or leaked', async () => {
    for (const holdoutProof of [
      {
        sealedProofRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `capture:sha256:${shaA}` },
        optimizerExposureProofRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `exposure-proof:sha256:${'b'.repeat(64)}`,
        },
        optimizerExposed: false,
      },
      {
        sealedProofRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `evaluation-proof:sha256:${shaA}`,
        },
        optimizerExposureProofRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `exposure-proof:sha256:${'b'.repeat(64)}`,
        },
        optimizerExposed: true,
      },
    ]) {
      const { adapter } = makeHarness({
        owner: {
          async resolveShowState() {
            return showState({ phase: 'approval_ready', holdoutProof });
          },
        },
      });

      const manifest = await adapter.manifest({ ...exactBase(), programSequence: 12 });
      assert.equal(manifest.tier, 'B');
      assert.equal(manifest.actionState, 'disabled');
    }
  });

  it('generates an honest Tier B manifest when owner truth is unavailable', async () => {
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          return { status: 'blocked', code: 'owner_route_unavailable' };
        },
      },
    });
    const manifest = await adapter.manifest({ ...exactBase(), programSequence: 3 });

    assert.equal(manifest.manifestVersion, 'f311-microduck-show-v1');
    assert.equal(manifest.tier, 'B');
    assert.equal(manifest.phase, 'blocked');
    assert.equal(manifest.actionState, 'disabled');
    assert.deepEqual(manifest.candidates, []);
    assert.deepEqual(manifest.blockers, [{ code: 'owner_route_unavailable' }]);
  });
});
