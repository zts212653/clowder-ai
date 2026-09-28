/**
 * F100 request-review owner adapter — version reader plus late-bound owner verbs.
 *
 * Gives the mutable accepted-source anchor a semantic version while retaining the Git blob as F311 source proof.
 *
 * Canonical asset identity (F314:227):
 *   assetKind = "skill"
 *   assetId   = "cat-cafe-skills/request-review/SKILL.md"
 *
 * The seven stateful verbs are resolved only after Redis/F266/F167 production
 * composition is complete. Missing owner runtime fails closed.
 *
 * Mutable scope (Cycle 1 variable):
 *   - accepted-source packet fields and their immediately following anchor explanation
 *
 * Immutable fence (NOT a variable, excluded):
 *   - every SKILL.md byte outside the accepted-source packet and explanation
 */
import type { EvolutionAssetReviewRequestV1, EvolutionAssetReviewV1 } from '@cat-cafe/shared';
import {
  PROGRAM_ADAPTER_CAPABILITIES,
  type ProgramAdapter,
  type ProgramAdapterDescriptorV1,
  type ProgramAdapterOperation,
} from '../program-adapter-registry.js';
import {
  REQUEST_REVIEW_OWNER_FEATURE_ID,
  REQUEST_REVIEW_SKILL_FILE,
  REQUEST_REVIEW_TARGET_STATE_REF,
  requestReviewAssetVersionRef,
} from './request-review-owner-identity.js';
import type { RequestReviewOwnerEvent, RequestReviewOwnerLedger } from './request-review-owner-ledger-contract.js';
import { requestReviewSemanticVersion, requestReviewSemanticVersionFromAnchor } from './request-review-owner-port.js';
import {
  hasRequestReviewAdoptionProof,
  hasRequestReviewAppliedUse,
  projectRequestReviewVersionFacts,
} from './request-review-owner-projection.js';

export { REQUEST_REVIEW_OWNER_FEATURE_ID } from './request-review-owner-identity.js';

/**
 * Exact target state ref for this adapter. Narrowed to the specific capability
 * so the registry does not intercept unrelated F100 capability objects.
 */
const TARGET_STATE_REF_PREFIX = REQUEST_REVIEW_TARGET_STATE_REF;

const descriptor: ProgramAdapterDescriptorV1 = {
  schemaVersion: 1,
  adapterId: 'request-review-owner-v1',
  adapterOwnerRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'adapter:request-review-owner-v1',
    version: '1',
  },
  targetOwnerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
  targetStateRefPrefix: TARGET_STATE_REF_PREFIX,
  capabilities: PROGRAM_ADAPTER_CAPABILITIES,
};

/**
 * Port for Git operations — injected for testability.
 * All reads MUST be pinned to the same commit to prevent dirty-worktree drift.
 */
export interface RequestReviewOwnerPort {
  /** Returns the 40-char Git commit OID of HEAD */
  gitHeadOid(): Promise<string>;
  /** Returns the 40-char Git blob OID for a file at a specific commit */
  gitBlobOidAt(commitOid: string, filePath: string): Promise<string>;
  /** Reads only the semantic accepted-source variable from a file at a specific commit. */
  readMutableAcceptedSourceAt(commitOid: string, filePath: string): Promise<string>;
  /** Reads the complete source file at a pinned commit for immutable-boundary verification. */
  readSkillFileAt(commitOid: string, filePath: string): Promise<string>;
  /** Lists newest-first commits that touched the file, with the exact blob at each commit. */
  listFileHistoryAt(commitOid: string, filePath: string, limit: number): Promise<RequestReviewGitVersion[]>;
}

export interface RequestReviewGitVersion {
  commitOid: string;
  blobOid: string;
  committedAt: string;
  subject: string;
}

export interface RequestReviewOwnerAdapterOptions {
  port: RequestReviewOwnerPort;
  ledger?: Pick<RequestReviewOwnerLedger, 'read'>;
  resolveActions?: () => RequestReviewOwnerActions | undefined;
}

export type RequestReviewOwnerActions = Pick<
  ProgramAdapter,
  'observe' | 'permission' | 'mutate' | 'verify' | 'writeback' | 'freshOutcome' | 'rollback'
>;

function ownerRef(stateRef: string, featureId = REQUEST_REVIEW_OWNER_FEATURE_ID) {
  return { ownerFeatureId: featureId, ownerStateRef: stateRef };
}

const ownerRuntimeUnavailable = async () => ({ status: 'blocked' as const, code: 'owner_runtime_unavailable' });

type ResolvedReview = Extract<EvolutionAssetReviewV1, { status: 'resolved' }>;
type VersionEntry = ResolvedReview['versions'][number];

function versionRefEquals(
  a: { ownerFeatureId: string; ownerStateRef: string; version: string; assetKind: string; assetId: string },
  b: { ownerFeatureId: string; ownerStateRef: string; version: string; assetKind: string; assetId: string },
): boolean {
  return (
    a.ownerFeatureId === b.ownerFeatureId &&
    a.ownerStateRef === b.ownerStateRef &&
    a.version === b.version &&
    a.assetKind === b.assetKind &&
    a.assetId === b.assetId
  );
}

/** Resolve the selected-version diff against the current catalog. */
async function resolveSelected(
  selectedVersionRef: NonNullable<EvolutionAssetReviewRequestV1['selectedVersionRef']>,
  versions: VersionEntry[],
  commitsByVersion: ReadonlyMap<string, string>,
  currentVersionRef: ReturnType<typeof requestReviewAssetVersionRef>,
  headOid: string,
  port: RequestReviewOwnerPort,
  events: readonly RequestReviewOwnerEvent[],
): Promise<ResolvedReview['selected']> {
  // Full identity comparison — all five fields, not just assetId + version
  const isInCatalog = versions.some((v) => versionRefEquals(v.versionRef, selectedVersionRef));

  // Finding 3 fix: do NOT fabricate unknown versions into the owner catalog.
  // If the selected version is not in catalog, return undefined — the caller
  // will return typed unavailable at the top level.
  if (!isInCatalog) return undefined;

  const selectedCommitOid = commitsByVersion.get(selectedVersionRef.version);
  if (!selectedCommitOid) return undefined;
  const currentContent = await port.readMutableAcceptedSourceAt(headOid, REQUEST_REVIEW_SKILL_FILE);
  const facts = projectRequestReviewVersionFacts(events, selectedVersionRef);
  let selectedContent: string;
  try {
    selectedContent =
      selectedCommitOid === headOid
        ? currentContent
        : await port.readMutableAcceptedSourceAt(selectedCommitOid, REQUEST_REVIEW_SKILL_FILE);
  } catch {
    return {
      versionRef: selectedVersionRef,
      diff: {
        status: 'unavailable',
        blocker: { code: 'owner_diff_unavailable', ownerRef: ownerRef(`git-commit:${selectedCommitOid}`) },
      },
      evidence: facts.evidence,
      uses: facts.uses,
    };
  }
  const summary =
    selectedVersionRef.version === currentVersionRef.version
      ? `Selected version is current; mutable accepted-source anchor:\n${currentContent}`
      : [
          `Selected mutable accepted-source anchor (${selectedCommitOid}):`,
          selectedContent,
          `Current mutable accepted-source anchor (${headOid}):`,
          currentContent,
        ].join('\n\n');

  return {
    versionRef: selectedVersionRef,
    diff: {
      status: 'available' as const,
      comparedToVersionRef: currentVersionRef,
      summary: summary.slice(0, 4_000),
      rawDiffRef: ownerRef(`git-diff:${selectedCommitOid}:${headOid}:${REQUEST_REVIEW_SKILL_FILE}`),
    },
    evidence: facts.evidence,
    uses: facts.uses,
  };
}

type SemanticGitVersion = RequestReviewGitVersion & { semanticVersion: string };

async function semanticHistory(
  history: readonly RequestReviewGitVersion[],
  port: RequestReviewOwnerPort,
  headOid: string,
  currentSemanticVersion: string,
): Promise<SemanticGitVersion[]> {
  const resolved: SemanticGitVersion[] = [];
  for (const entry of history) {
    try {
      if (entry.commitOid === headOid) {
        resolved.push({ ...entry, semanticVersion: currentSemanticVersion });
        continue;
      }
      const anchor = await port.readMutableAcceptedSourceAt(entry.commitOid, REQUEST_REVIEW_SKILL_FILE);
      resolved.push({ ...entry, semanticVersion: requestReviewSemanticVersionFromAnchor(anchor) });
    } catch {
      // Commits before the accepted-source variable existed are source history,
      // not experiment versions, and therefore cannot enter the catalog.
    }
  }
  return resolved;
}

function buildVersionCatalog(history: readonly SemanticGitVersion[], current: SemanticGitVersion) {
  const distinct: SemanticGitVersion[] = [];
  const seen = new Set<string>();
  for (const entry of [current, ...history]) {
    if (seen.has(entry.semanticVersion)) continue;
    seen.add(entry.semanticVersion);
    distinct.push(entry);
  }
  const commitsByVersion = new Map(distinct.map((entry) => [entry.semanticVersion, entry.commitOid]));
  const versions: VersionEntry[] = distinct.map((entry, index) => {
    const parent = distinct[index + 1];
    return {
      versionRef: requestReviewAssetVersionRef(entry.semanticVersion),
      title: `${entry.subject} (${entry.committedAt})`.slice(0, 240),
      parentEdges: parent
        ? [
            {
              parentVersionRef: requestReviewAssetVersionRef(parent.semanticVersion),
              edgeRef: ownerRef(`git-parent:${entry.commitOid}:${parent.commitOid}`),
            },
          ]
        : [],
    };
  });
  return { versions, commitsByVersion };
}

function standingBlockers(events: readonly RequestReviewOwnerEvent[], currentVersionRef: VersionEntry['versionRef']) {
  return [
    ...(hasRequestReviewAdoptionProof(events, currentVersionRef)
      ? []
      : [{ code: 'adoption_proof_unavailable', ownerRef: ownerRef(TARGET_STATE_REF_PREFIX) }]),
    ...(hasRequestReviewAppliedUse(events, currentVersionRef)
      ? []
      : [{ code: 'applied_use_proof_unavailable', ownerRef: ownerRef(TARGET_STATE_REF_PREFIX) }]),
  ];
}

export function createRequestReviewOwnerAdapter(options: RequestReviewOwnerAdapterOptions): ProgramAdapter {
  const { port } = options;

  const delegate =
    (operation: keyof RequestReviewOwnerActions): ProgramAdapterOperation =>
    async (input: never) => {
      const actions = options.resolveActions?.();
      return actions ? actions[operation](input) : ownerRuntimeUnavailable();
    };

  const versionReview = async (input: EvolutionAssetReviewRequestV1): Promise<EvolutionAssetReviewV1> => {
    const { programRef, objectRef, selectedVersionRef } = input;
    const envelope = { schemaVersion: 1 as const, programRef, objectRef };

    // Exact objectRef guard — the registry uses startsWith() prefix matching,
    // so suffix capabilities like "...-shadow" can leak through. This adapter
    // only serves the exact F314 capability object; reject everything else.
    if (
      objectRef.ownerFeatureId !== REQUEST_REVIEW_OWNER_FEATURE_ID ||
      objectRef.ownerStateRef !== TARGET_STATE_REF_PREFIX
    ) {
      return {
        ...envelope,
        status: 'unavailable' as const,
        blockers: [{ code: 'object_scope_mismatch', ownerRef: objectRef }],
      };
    }

    try {
      // Pin HEAD first, then derive all data from that exact commit
      const headOid = await port.gitHeadOid();
      const skillBlobOid = await port.gitBlobOidAt(headOid, REQUEST_REVIEW_SKILL_FILE);
      const history = await port.listFileHistoryAt(headOid, REQUEST_REVIEW_SKILL_FILE, 64);
      const currentSkill = await port.readSkillFileAt(headOid, REQUEST_REVIEW_SKILL_FILE);
      const events = options.ledger ? await options.ledger.read() : [];

      // Finding 1 fix: single canonical asset per F314:227
      const currentSemanticVersion = requestReviewSemanticVersion(currentSkill);
      const currentVersionRef = requestReviewAssetVersionRef(currentSemanticVersion);
      const currentVersionRefs = [currentVersionRef];
      const resolvedHistory = await semanticHistory(history, port, headOid, currentSemanticVersion);
      const currentHistory = resolvedHistory.find((entry) => entry.commitOid === headOid);
      const current =
        currentHistory ??
        ({
          commitOid: headOid,
          blobOid: skillBlobOid,
          semanticVersion: currentSemanticVersion,
          committedAt: new Date(0).toISOString(),
          subject: 'Current request-review skill',
        } satisfies SemanticGitVersion);
      const { versions, commitsByVersion } = buildVersionCatalog(resolvedHistory, current);

      const selected = selectedVersionRef
        ? await resolveSelected(
            selectedVersionRef,
            versions,
            commitsByVersion,
            currentVersionRef,
            headOid,
            port,
            events,
          )
        : undefined;

      // Finding 3 fix: if selected was requested but not in catalog, return unavailable
      if (selectedVersionRef && selected === undefined) {
        return {
          ...envelope,
          status: 'unavailable' as const,
          blockers: [{ code: 'owner_version_not_found', ownerRef: objectRef }],
        };
      }

      return {
        ...envelope,
        status: 'resolved' as const,
        sourceRef: ownerRef(`skill:${REQUEST_REVIEW_SKILL_FILE}`),
        readAt: new Date().toISOString(),
        currentVersionRefs,
        currentProofRef: ownerRef(`git-blob:${headOid}:${skillBlobOid}`),
        versions,
        ...(selected !== undefined ? { selected } : {}),
        blockers: standingBlockers(events, currentVersionRef),
      };
    } catch {
      return {
        ...envelope,
        status: 'unavailable' as const,
        blockers: [{ code: 'owner_read_failed', ownerRef: objectRef }],
      };
    }
  };

  return {
    descriptor,
    observe: delegate('observe'),
    permission: delegate('permission'),
    mutate: delegate('mutate'),
    verify: delegate('verify'),
    writeback: delegate('writeback'),
    freshOutcome: delegate('freshOutcome'),
    rollback: delegate('rollback'),
    versionReview,
  };
}
