import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createBootstrapAttestation,
  resolveGovernanceTarget,
  useAttestedExportedBaselineProjection,
  validateBootstrapAttestation,
} from '../src/tool-governance-bootstrap.js';

const baseSha = 'a'.repeat(40);
const homeBootstrapSha = '265f7b998f7b8cae81d26d88db58351cf02b030d';

describe('F286 bootstrap attestation', () => {
  it('binds the canonical public introduction to the immutable source attestation', () => {
    const attestation = createBootstrapAttestation(homeBootstrapSha);

    assert.equal(attestation.schemaVersion, 2);
    assert.deepEqual((attestation as unknown as { exportedTargets?: readonly unknown[] }).exportedTargets, [
      {
        targetRepository: 'zts212653/clowder-ai',
        targetRef: 'origin/main',
        bootstrapCommit: '5115761a67dd30a6a7af57a9bb4c07c4f5dd5762',
        bootstrapParent: '69efbd889d30aad8074922c88b159b674e69e614',
        sourceSnapshot: 'f0186f814dacf37885419a54ebe44466439df09c',
        projectionCommit: 'acbe72825628f268560d5d6059d608a7983a78e2',
        projectionParent: 'dc582b899ebdcb6f7bb3c6abf2eb81090f8c1c3d',
        projectionSourceSnapshot: '7e813d323070433ed9b48bfc2b48bebb45151b0d',
        legacyBaselineDigest: 'sha256:a2398c0f860006f33b7418db2e539ef1513d4f8692a3c07d7ea0a309bad5ab7f',
        projectedBaselineDigest: 'sha256:b286a3d6420a560b5aa776faae123ecafa62961cef80face57535f7e5cf03dbd',
        provenanceManifestVersion: 3,
      },
    ]);
  });

  it('uses an exact gate-start target instead of refetching a moving origin/main', () => {
    assert.deepEqual(resolveGovernanceTarget(undefined), { fetchLatest: true, ref: 'origin/main' });
    assert.deepEqual(resolveGovernanceTarget(baseSha), { fetchLatest: false, ref: baseSha });
    assert.throws(() => resolveGovernanceTarget('origin/main'), /exact Git SHA/i);
  });

  it('accepts the sole first-baseline target when the protected ref is exact and baseline-free', () => {
    const attestation = createBootstrapAttestation(baseSha);
    assert.doesNotThrow(() =>
      validateBootstrapAttestation(attestation, {
        mode: 'check',
        resolvedTargetSha: baseSha,
        targetHasBaseline: false,
        currentHasBaseline: true,
      }),
    );
  });

  it('fails closed on mutation, stale target replay, missing baseline, and target overrides', () => {
    const attestation = createBootstrapAttestation(baseSha);
    assert.throws(
      () => validateBootstrapAttestation({ ...attestation, owner: 'architecture-cell:other' }, context()),
      /closed fields|digest/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), resolvedTargetSha: 'b'.repeat(40) }),
      /does not match attested bootstrap/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), currentHasBaseline: false }),
      /current baseline is missing/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), requestedTargetOverride: 'HEAD~1' }),
      /target overrides are forbidden/i,
    );
  });

  it('makes bootstrap unreachable after origin/main contains the baseline', () => {
    const attestation = createBootstrapAttestation(baseSha);
    const targetProof = {
      kind: 'source' as const,
      bootstrapIsTargetAncestor: true,
      exportedSourceSnapshotsAreTargetAncestors: true,
    };
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          mode: 'attest',
          resolvedTargetSha: 'b'.repeat(40),
          targetHasBaseline: true,
          currentHasBaseline: true,
          targetBaselineProtectedBaseSha: baseSha,
          targetProof,
        }),
      /bootstrap is already complete/i,
    );
    assert.doesNotThrow(() =>
      validateBootstrapAttestation(attestation, {
        mode: 'check',
        resolvedTargetSha: 'b'.repeat(40),
        targetHasBaseline: true,
        currentHasBaseline: true,
        targetBaselineProtectedBaseSha: baseSha,
        targetProof,
      }),
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          mode: 'write',
          resolvedTargetSha: 'b'.repeat(40),
          targetHasBaseline: true,
          currentHasBaseline: false,
          targetBaselineProtectedBaseSha: baseSha,
          targetProof,
        }),
      /cannot be deleted and recreated/i,
    );
  });

  it('accepts the attested public lineage and rejects altered mapping evidence', () => {
    const attestation = createBootstrapAttestation(homeBootstrapSha);
    const target = attestation.exportedTargets[0];
    const witness = {
      bootstrapCommit: target.bootstrapCommit,
      parentShas: [target.bootstrapParent],
      provenance: {
        source_commit_sha: target.sourceSnapshot,
        target_head_sha: target.bootstrapParent,
        manifest_version: target.provenanceManifestVersion,
      },
      legacyAttestation: {
        schemaVersion: 1,
        featureId: 'F286',
        targetRepository: 'zts212653/cat-cafe',
        targetRef: 'origin/main',
        bootstrapFrom: homeBootstrapSha,
        cvoAuthorizationRef: 'message:0001785600399637-001062-9b03f289',
        adrAuthorizationRef: 'adr:44',
        expectedAbsentBaselinePath: 'packages/mcp-server/governance/mcp-surface-baseline.json',
        owner: 'architecture-cell:mcp-surface-governance',
        attestationSourceDigest: 'sha256:67ca45135accd5b030f197debbe62dc4a847c410258abce7f069e5de8a572a26',
      },
      baselineProtectedBaseSha: homeBootstrapSha,
      projectionCommit: target.projectionCommit,
      projectionParentShas: [target.projectionParent],
      projectionProvenance: {
        source_commit_sha: target.projectionSourceSnapshot,
        target_head_sha: target.projectionParent,
        manifest_version: target.provenanceManifestVersion,
      },
    };
    const exportedContext = {
      mode: 'check' as const,
      resolvedTargetSha: 'b'.repeat(40),
      targetHasBaseline: true,
      currentHasBaseline: true,
      targetBaselineProtectedBaseSha: homeBootstrapSha,
      targetProof: {
        kind: 'exported' as const,
        target,
        bootstrapIsTargetAncestor: true,
        projectionIsTargetAncestor: true,
        witness,
      },
    };

    assert.doesNotThrow(() => validateBootstrapAttestation(attestation, exportedContext));
    assert.doesNotThrow(() => validateBootstrapAttestation(attestation, { ...exportedContext, mode: 'write' }));
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: {
            ...exportedContext.targetProof,
            witness: {
              ...witness,
              provenance: { ...witness.provenance, source_commit_sha: 'c'.repeat(40) },
            },
          },
        }),
      /source mapping/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: {
            ...exportedContext.targetProof,
            witness: { ...witness, parentShas: ['d'.repeat(40)] },
          },
        }),
      /parent/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: {
            ...exportedContext.targetProof,
            witness: { ...witness, baselineProtectedBaseSha: 'e'.repeat(40) },
          },
        }),
      /source protected base/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: { ...exportedContext.targetProof, projectionIsTargetAncestor: false },
        }),
      /projection.*ancestor/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: {
            ...exportedContext.targetProof,
            witness: {
              ...witness,
              projectionProvenance: {
                ...witness.projectionProvenance,
                source_commit_sha: 'f'.repeat(40),
              },
            },
          },
        }),
      /projection provenance/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(
          {
            ...attestation,
            exportedTargets: [{ ...target, projectionCommit: 'f'.repeat(40) }],
          },
          exportedContext,
        ),
      /exportedTargets|digest/i,
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          ...exportedContext,
          targetProof: { kind: 'unresolved' },
        }),
      /no valid.*lineage/i,
    );
    assert.equal(
      useAttestedExportedBaselineProjection(target, target.legacyBaselineDigest, target.projectedBaselineDigest),
      true,
    );
    assert.equal(
      useAttestedExportedBaselineProjection(target, 'sha256:already-projected', 'sha256:later-change'),
      false,
    );
    assert.throws(
      () => useAttestedExportedBaselineProjection(target, target.legacyBaselineDigest, 'sha256:forged'),
      /source-attested public projection/i,
    );
  });

  it('rejects source checks when an attested exported snapshot is outside source history', () => {
    const attestation = createBootstrapAttestation(homeBootstrapSha);
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          mode: 'check',
          resolvedTargetSha: 'b'.repeat(40),
          targetHasBaseline: true,
          currentHasBaseline: true,
          targetBaselineProtectedBaseSha: homeBootstrapSha,
          targetProof: {
            kind: 'source',
            bootstrapIsTargetAncestor: true,
            exportedSourceSnapshotsAreTargetAncestors: false,
          },
        }),
      /source snapshot/i,
    );
  });
});

function context() {
  return {
    mode: 'check' as const,
    resolvedTargetSha: baseSha,
    targetHasBaseline: false,
    currentHasBaseline: true,
  };
}
