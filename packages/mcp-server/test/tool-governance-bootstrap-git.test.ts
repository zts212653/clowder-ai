import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createBootstrapAttestation, validateBootstrapAttestation } from '../src/tool-governance-bootstrap.js';
import { type GovernanceGitRead, resolveBootstrapTargetProof } from '../src/tool-governance-bootstrap-git.js';

const homeBootstrapSha = '265f7b998f7b8cae81d26d88db58351cf02b030d';

describe('F286 exported bootstrap Git proof', () => {
  it('resolves the exact public history and provenance witness', async () => {
    const attestation = createBootstrapAttestation(homeBootstrapSha);
    const target = attestation.exportedTargets[0];
    const responses = new Map<string, string>([
      [`merge-base --is-ancestor ${target.bootstrapCommit} public-head`, ''],
      [`merge-base --is-ancestor ${target.projectionCommit} public-head`, ''],
      [`rev-list --parents -n 1 ${target.bootstrapCommit}`, `${target.bootstrapCommit} ${target.bootstrapParent}`],
      [`rev-list --parents -n 1 ${target.projectionCommit}`, `${target.projectionCommit} ${target.projectionParent}`],
      [
        `show ${target.bootstrapCommit}:.sync-provenance.json`,
        JSON.stringify({
          source_commit_sha: target.sourceSnapshot,
          target_head_sha: target.bootstrapParent,
          manifest_version: target.provenanceManifestVersion,
        }),
      ],
      [
        `show ${target.projectionCommit}:.sync-provenance.json`,
        JSON.stringify({
          source_commit_sha: target.projectionSourceSnapshot,
          target_head_sha: target.projectionParent,
          manifest_version: target.provenanceManifestVersion,
        }),
      ],
      [
        `show ${target.bootstrapCommit}:packages/mcp-server/governance/mcp-surface-bootstrap-attestation.json`,
        JSON.stringify(legacyAttestation()),
      ],
      [
        `show ${target.bootstrapCommit}:packages/mcp-server/governance/mcp-surface-baseline.json`,
        JSON.stringify({ protectedBaseSha: homeBootstrapSha }),
      ],
    ]);
    const readGit: GovernanceGitRead = async (args) => responses.get(args.join(' ')) ?? null;

    const proof = await resolveBootstrapTargetProof({ readGit, resolvedTargetSha: 'public-head', attestation });
    assert.equal(proof.kind, 'exported');
    assert.doesNotThrow(() =>
      validateBootstrapAttestation(attestation, {
        mode: 'check',
        resolvedTargetSha: 'public-head',
        targetHasBaseline: true,
        currentHasBaseline: true,
        targetBaselineProtectedBaseSha: homeBootstrapSha,
        targetProof: proof,
      }),
    );
  });

  it('does not infer an exported repository from nearby or unrelated history', async () => {
    const attestation = createBootstrapAttestation(homeBootstrapSha);
    const proof = await resolveBootstrapTargetProof({
      readGit: async () => null,
      resolvedTargetSha: 'unrelated-head',
      attestation,
    });
    assert.deepEqual(proof, { kind: 'unresolved' });
  });
});

function legacyAttestation() {
  return {
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
  };
}
