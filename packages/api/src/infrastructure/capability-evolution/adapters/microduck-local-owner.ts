import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type EvolutionAssetReviewRequestV1,
  type EvolutionAssetReviewV1,
  type EvolutionPreparationMediaRequestV1,
  type EvolutionPreparationReviewRequestV1,
  type EvolutionPreparationReviewV1,
  evolutionAssetReviewV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { createMicroduckExplorationBindings } from './microduck-exploration/publication.js';
import { type MicroduckLocalEvidenceOptions, readMicroduckLocalEvidence } from './microduck-local-owner-evidence.js';
import type { MicroduckBlocked, MicroduckOwnerPort, MicroduckProgramScope } from './microduck-owner-contract.js';
import type { MicroduckOwnerRuntimeBindings, MicroduckOwnerRuntimeRegistration } from './microduck-owner-runtime.js';
import { microduckOwnerRuntimeRegistration } from './microduck-owner-runtime.js';
import {
  type MicroduckPreparationMediaAsset,
  readMicroduckFootballPreparationMedia,
} from './microduck-preparation/football-publication.js';
import { readMicroduckPreparationPublication } from './microduck-preparation/publication.js';

const blocked = (code: MicroduckBlocked['code']): MicroduckBlocked => ({ status: 'blocked', code });
const ownerRef = (ownerStateRef: string, version?: string) => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef,
  ...(version ? { version } : {}),
});

function exactScope(input: MicroduckProgramScope): boolean {
  return (
    input.programRef.ownerFeatureId === 'F311' &&
    input.cycleRef.ownerFeatureId === 'F311' &&
    input.objectRef.ownerFeatureId === 'microduck-owner' &&
    input.objectRef.ownerStateRef === 'simulator:walking'
  );
}

export function createMicroduckLocalOwnerBindings(
  options: MicroduckLocalEvidenceOptions & { now?: () => string },
): MicroduckOwnerRuntimeBindings {
  const now = options.now ?? (() => new Date().toISOString());
  const rawRead = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const readPreparationBytes = (path: string) => rawRead(resolve(options.repoRoot, path));
  const evidenceFor = async (input: MicroduckProgramScope) => {
    if (!exactScope(input)) return blocked('owner_route_unavailable');
    const evidence = await readMicroduckLocalEvidence(options);
    if (evidence.status === 'blocked') return evidence;
    return input.objectRef.version === evidence.targetVersionRef.version ? evidence : blocked('target_drift');
  };
  const owner: MicroduckOwnerPort = {
    async observe(input) {
      const evidence = await evidenceFor(input);
      if (evidence.status === 'blocked') return evidence;
      const captureRef = ownerRef(`capture:sha256:${evidence.captureSha256}`);
      return {
        status: 'observed',
        targetVersionRef: evidence.targetVersionRef,
        baselineVersionRef: evidence.baselineVersionRef,
        observationRefs: [captureRef],
        baselineArtifactSha256: evidence.artifactSha256,
        sceneMedia: [{ sceneIndex: 0, source: 'real_capture', captureRef, kind: 'image' }],
      };
    },
    async launchMutation() {
      return blocked('permission_missing');
    },
    async resolveVerification() {
      return blocked('verification_missing');
    },
    async writeback() {
      return blocked('permission_missing');
    },
    async collectFreshOutcome() {
      return blocked('fresh_outcome_missing');
    },
    async rollback() {
      return blocked('permission_missing');
    },
    async resolveShowState() {
      return blocked('show_truth_incomplete');
    },
    async resolveShowMedia(input) {
      const evidence = await evidenceFor(input);
      if (evidence.status === 'blocked') return evidence;
      const captureRef = ownerRef(`capture:sha256:${evidence.captureSha256}`);
      if (input.sceneIndex !== 0 || refIdentity(input.captureRef) !== refIdentity(captureRef)) {
        return blocked('show_truth_incomplete');
      }
      return {
        status: 'resolved',
        captureRef,
        kind: 'image',
        contentType: 'image/png',
        bytes: evidence.captureBytes,
      };
    },
  };
  const versionReview = async (input: EvolutionAssetReviewRequestV1): Promise<EvolutionAssetReviewV1> => {
    const evidence = await evidenceFor({
      programRef: input.programRef,
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${input.programRef.ownerStateRef}:1` },
      objectRef: input.objectRef,
    });
    if (evidence.status === 'blocked') {
      return {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: input.programRef,
        objectRef: input.objectRef,
        blockers: [{ code: evidence.code, ownerRef: input.objectRef }],
      };
    }
    const publication = await readMicroduckPreparationPublication(options, input, now);
    const candidateVersions = publication.status === 'resolved' ? publication.candidateVersions : [];
    const selectedVersionRef = input.selectedVersionRef;
    const selectedCandidate = selectedVersionRef
      ? candidateVersions.find((candidate) => refIdentity(candidate.versionRef) === refIdentity(selectedVersionRef))
      : undefined;
    if (
      selectedVersionRef &&
      refIdentity(selectedVersionRef) !== refIdentity(evidence.baselineVersionRef) &&
      !selectedCandidate
    ) {
      return {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: input.programRef,
        objectRef: input.objectRef,
        blockers: [{ code: 'owner_version_not_found', ownerRef: selectedVersionRef }],
      };
    }
    const captureRef = ownerRef(`capture:sha256:${evidence.captureSha256}`);
    const baselineOwnerRef = ownerRef(evidence.baselineVersionRef.ownerStateRef, evidence.baselineVersionRef.version);
    const selected = selectedCandidate
      ? {
          versionRef: selectedCandidate.versionRef,
          diff: {
            status: 'unavailable' as const,
            blocker: {
              code: 'selected_asset_live_current_missing',
              ownerRef: ownerRef(selectedCandidate.versionRef.ownerStateRef, selectedCandidate.versionRef.version),
            },
          },
          evidence: [],
          uses: [],
        }
      : {
          versionRef: evidence.baselineVersionRef,
          diff: {
            status: 'available' as const,
            comparedToVersionRef: evidence.baselineVersionRef,
            summary: '当前采用官方 walking ONNX；本地没有修改 policy。',
            rawDiffRef: baselineOwnerRef,
            ownerHref: evidence.policyUrl,
          },
          evidence: [
            {
              role: 'comparison_baseline' as const,
              assetVersionRef: evidence.baselineVersionRef,
              evidenceRef: baselineOwnerRef,
              proofRef: captureRef,
              status: 'insufficient' as const,
              label: '本地 ONNX 61→14 推理 smoke 已通过；这不是步态鲁棒性评估。',
              ownerHref: `/api/capability-evolution/programs/${encodeURIComponent(input.programRef.ownerStateRef)}/adapter-media/0`,
            },
          ],
          uses: [],
        };
    return evolutionAssetReviewV1Schema.parse({
      schemaVersion: 1,
      status: 'resolved',
      programRef: input.programRef,
      objectRef: input.objectRef,
      sourceRef: baselineOwnerRef,
      readAt: now(),
      currentVersionRefs: [evidence.baselineVersionRef],
      currentProofRef: baselineOwnerRef,
      versions: [
        { versionRef: evidence.baselineVersionRef, title: '官方 walking ONNX baseline', parentEdges: [] },
        ...candidateVersions.map((candidate) => ({ ...candidate, parentEdges: [] })),
      ],
      selected,
      blockers: [
        {
          code: 'baseline_robustness_evaluation_missing',
          ownerRef: ownerRef('evaluation:baseline-robustness:missing'),
        },
        ...(publication.status === 'resolved'
          ? [
              {
                code: 'sealed_holdout_not_published',
                ownerRef: publication.publicEvaluationRef,
              },
            ]
          : [
              {
                code: 'public_candidate_catalog_unavailable',
                ownerRef: input.objectRef,
              },
            ]),
      ],
    });
  };
  const preparationReview = async (
    input: EvolutionPreparationReviewRequestV1,
  ): Promise<EvolutionPreparationReviewV1> => {
    const evidence = await evidenceFor({
      programRef: input.programRef,
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${input.programRef.ownerStateRef}:1` },
      objectRef: input.objectRef,
    });
    if (evidence.status === 'blocked') {
      return {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: input.programRef,
        objectRef: input.objectRef,
        blockers: [{ code: evidence.code, ownerRef: input.objectRef }],
      };
    }
    const publication = await readMicroduckPreparationPublication(options, input, now);
    return publication.status === 'resolved'
      ? publication.review
      : {
          schemaVersion: 1,
          status: 'unavailable',
          programRef: input.programRef,
          objectRef: input.objectRef,
          blockers: [{ code: publication.code, ownerRef: input.objectRef }],
        };
  };
  const preparationMedia = async (
    input: EvolutionPreparationMediaRequestV1,
  ): Promise<MicroduckPreparationMediaAsset | MicroduckBlocked> => {
    const evidence = await evidenceFor({
      programRef: input.programRef,
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${input.programRef.ownerStateRef}:1` },
      objectRef: input.objectRef,
    });
    return evidence.status === 'blocked'
      ? evidence
      : readMicroduckFootballPreparationMedia(readPreparationBytes, input);
  };
  return {
    owner,
    credentialBoundary: {
      async authorize() {
        return blocked('permission_missing');
      },
    },
    versionReview,
    preparationReview,
    preparationMedia,
    ...createMicroduckExplorationBindings({ ...options, versionReview }),
  };
}

export function registerMicroduckLocalOwnerRuntime(
  options: MicroduckLocalEvidenceOptions & {
    registration?: MicroduckOwnerRuntimeRegistration;
  },
): boolean {
  const registration = options.registration ?? microduckOwnerRuntimeRegistration;
  if (registration.snapshot()) return false;
  registration.connect(createMicroduckLocalOwnerBindings(options));
  return true;
}
