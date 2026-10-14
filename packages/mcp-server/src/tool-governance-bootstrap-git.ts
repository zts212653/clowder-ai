import {
  type BootstrapTargetProof,
  MCP_SURFACE_ATTESTATION_PATH,
  MCP_SURFACE_BASELINE_PATH,
  type McpSurfaceBootstrapAttestation,
} from './tool-governance-bootstrap.js';

export type GovernanceGitRead = (args: readonly string[], allowFailure?: boolean) => Promise<string | null>;

async function isAncestor(readGit: GovernanceGitRead, ancestor: string, descendant: string): Promise<boolean> {
  return (await readGit(['merge-base', '--is-ancestor', ancestor, descendant], true)) !== null;
}

async function jsonAtCommit(readGit: GovernanceGitRead, sha: string, path: string): Promise<unknown> {
  const content = await readGit(['show', `${sha}:${path}`], true);
  if (content === null) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function revisionWitness(line: string | null, subject: string): { commit: string; parentShas: readonly string[] } {
  if (line === null || line.trim() === '') throw new Error(`Cannot resolve ${subject} revision witness`);
  const [commit, ...parentShas] = line.split(/\s+/);
  if (!commit) throw new Error(`Cannot resolve ${subject} commit`);
  return { commit, parentShas };
}

export async function resolveBootstrapTargetProof(input: {
  readGit: GovernanceGitRead;
  resolvedTargetSha: string;
  attestation: McpSurfaceBootstrapAttestation;
}): Promise<BootstrapTargetProof> {
  const { readGit, resolvedTargetSha, attestation } = input;
  if (await isAncestor(readGit, attestation.bootstrapFrom, resolvedTargetSha)) {
    const exportedSourceSnapshotsAreTargetAncestors = (
      await Promise.all(
        attestation.exportedTargets.flatMap((target) =>
          [target.sourceSnapshot, target.projectionSourceSnapshot].map((sourceSnapshot) =>
            isAncestor(readGit, sourceSnapshot, resolvedTargetSha),
          ),
        ),
      )
    ).every(Boolean);
    return { kind: 'source', bootstrapIsTargetAncestor: true, exportedSourceSnapshotsAreTargetAncestors };
  }

  const candidates: (typeof attestation.exportedTargets)[number][] = [];
  for (const target of attestation.exportedTargets) {
    if (await isAncestor(readGit, target.bootstrapCommit, resolvedTargetSha)) candidates.push(target);
  }
  const target = candidates.length === 1 ? candidates[0] : undefined;
  if (!target) return { kind: 'unresolved' };

  const commitLine = await readGit(['rev-list', '--parents', '-n', '1', target.bootstrapCommit], true);
  const projectionCommitLine = await readGit(['rev-list', '--parents', '-n', '1', target.projectionCommit], true);
  const bootstrapRevision = revisionWitness(commitLine, 'exported bootstrap');
  const projectionRevision = revisionWitness(projectionCommitLine, 'exported projection');
  const provenance = await jsonAtCommit(readGit, target.bootstrapCommit, '.sync-provenance.json');
  const legacyAttestation = await jsonAtCommit(readGit, target.bootstrapCommit, MCP_SURFACE_ATTESTATION_PATH);
  const baseline = await jsonAtCommit(readGit, target.bootstrapCommit, MCP_SURFACE_BASELINE_PATH);
  const projectionProvenance = await jsonAtCommit(readGit, target.projectionCommit, '.sync-provenance.json');
  return {
    kind: 'exported',
    target,
    bootstrapIsTargetAncestor: true,
    projectionIsTargetAncestor: await isAncestor(readGit, target.projectionCommit, resolvedTargetSha),
    witness: {
      bootstrapCommit: bootstrapRevision.commit,
      parentShas: bootstrapRevision.parentShas,
      provenance,
      legacyAttestation,
      baselineProtectedBaseSha: stringField(baseline, 'protectedBaseSha'),
      projectionCommit: projectionRevision.commit,
      projectionParentShas: projectionRevision.parentShas,
      projectionProvenance,
    },
  };
}
