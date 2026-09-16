import type {
  EvolutionAssetReviewRequestV1,
  EvolutionAssetReviewV1,
  EvolutionPreparationMediaRequestV1,
  EvolutionPreparationReviewRequestV1,
  EvolutionPreparationReviewV1,
} from '@cat-cafe/shared';
import { unavailableExploration } from '../read-model/program-exploration.js';
import type { MicroduckExplorationBindings } from './microduck-exploration/publication.js';
import { createMicroduckOwnerAdapter } from './microduck-owner-adapter.js';
import type {
  MicroduckApprovalResolver,
  MicroduckBlocked,
  MicroduckCredentialBoundary,
  MicroduckOwnerPort,
  MicroduckProposalResolver,
} from './microduck-owner-contract.js';
import type { MicroduckPreparationMediaAsset } from './microduck-preparation/football-publication.js';

export interface MicroduckOwnerRuntimeBindings extends Partial<MicroduckExplorationBindings> {
  owner: MicroduckOwnerPort;
  credentialBoundary: MicroduckCredentialBoundary;
  versionReview?: (input: EvolutionAssetReviewRequestV1) => Promise<EvolutionAssetReviewV1>;
  preparationReview?: (input: EvolutionPreparationReviewRequestV1) => Promise<EvolutionPreparationReviewV1>;
  preparationMedia?: (
    input: EvolutionPreparationMediaRequestV1,
  ) => Promise<MicroduckPreparationMediaAsset | MicroduckBlocked>;
}

/**
 * Process-local composition only. The provider keeps canonical receipts and credentials; this seam
 * retains no owner state and remains blocked until an owner implementation connects at bootstrap.
 */
export class MicroduckOwnerRuntimeRegistration {
  private bindings?: MicroduckOwnerRuntimeBindings;

  connect(bindings: MicroduckOwnerRuntimeBindings): void {
    if (this.bindings) throw new Error('Microduck owner runtime is already connected');
    this.bindings = bindings;
  }

  snapshot(): MicroduckOwnerRuntimeBindings | undefined {
    return this.bindings;
  }
}

export const microduckOwnerRuntimeRegistration = new MicroduckOwnerRuntimeRegistration();

export interface MicroduckRuntimeAdapterOptions {
  registration?: Pick<MicroduckOwnerRuntimeRegistration, 'snapshot'>;
  approvalResolver?: MicroduckApprovalResolver;
  proposalResolver?: MicroduckProposalResolver;
}

async function guardedOwnerCall<T>(
  registration: Pick<MicroduckOwnerRuntimeRegistration, 'snapshot'>,
  invoke: (bindings: MicroduckOwnerRuntimeBindings) => Promise<T>,
  code: MicroduckBlocked['code'],
): Promise<T | MicroduckBlocked> {
  try {
    const bindings = registration.snapshot();
    return bindings ? await invoke(bindings) : { status: 'blocked', code };
  } catch {
    return { status: 'blocked', code };
  }
}

export function createMicroduckRuntimeAdapter(options: MicroduckRuntimeAdapterOptions = {}) {
  const registration = options.registration ?? microduckOwnerRuntimeRegistration;
  const owner: MicroduckOwnerPort = {
    async observe(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.observe(input), 'owner_route_unavailable');
    },
    async launchMutation(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.launchMutation(input),
        'owner_route_unavailable',
      );
    },
    async resolveVerification(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.resolveVerification(input),
        'owner_route_unavailable',
      );
    },
    async writeback(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.writeback(input), 'owner_route_unavailable');
    },
    async collectFreshOutcome(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.collectFreshOutcome(input),
        'owner_route_unavailable',
      );
    },
    async rollback(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.rollback(input), 'owner_route_unavailable');
    },
    async resolveShowState(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.resolveShowState(input),
        'owner_route_unavailable',
      );
    },
    async resolveShowMedia(input) {
      return guardedOwnerCall(
        registration,
        async (bindings) => {
          if (typeof bindings.owner.resolveShowMedia !== 'function') {
            return { status: 'blocked' as const, code: 'show_truth_incomplete' as const };
          }
          return bindings.owner.resolveShowMedia(input);
        },
        'show_truth_incomplete',
      );
    },
  };
  const credentialBoundary: MicroduckCredentialBoundary = {
    async authorize(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.credentialBoundary.authorize(input),
        'permission_missing',
      );
    },
  };
  const approvalResolver: MicroduckApprovalResolver = options.approvalResolver ?? {
    async resolve() {
      return { status: 'blocked', code: 'approval_missing' };
    },
  };
  const proposalResolver: MicroduckProposalResolver = options.proposalResolver ?? {
    async resolve() {
      return { status: 'blocked', code: 'approval_missing' };
    },
  };
  const versionReview = async (input: EvolutionAssetReviewRequestV1): Promise<EvolutionAssetReviewV1> => {
    const unavailable = (): EvolutionAssetReviewV1 => ({
      schemaVersion: 1,
      status: 'unavailable',
      programRef: input.programRef,
      objectRef: input.objectRef,
      blockers: [{ code: 'owner_version_review_unavailable', ownerRef: input.objectRef }],
    });
    const result = await guardedOwnerCall(
      registration,
      async (bindings) => (bindings.versionReview ? bindings.versionReview(input) : unavailable()),
      'owner_route_unavailable',
    );
    return result.status === 'blocked' ? unavailable() : result;
  };
  const preparationReview = async (
    input: EvolutionPreparationReviewRequestV1,
  ): Promise<EvolutionPreparationReviewV1> => {
    const unavailable = (): EvolutionPreparationReviewV1 => ({
      schemaVersion: 1,
      status: 'unavailable',
      programRef: input.programRef,
      objectRef: input.objectRef,
      blockers: [{ code: 'owner_preparation_reader_missing', ownerRef: input.objectRef }],
    });
    const result = await guardedOwnerCall(
      registration,
      async (bindings) => (bindings.preparationReview ? bindings.preparationReview(input) : unavailable()),
      'owner_route_unavailable',
    );
    return result.status === 'blocked' ? unavailable() : result;
  };
  const preparationMedia = async (input: EvolutionPreparationMediaRequestV1) =>
    guardedOwnerCall(
      registration,
      async (bindings) =>
        bindings.preparationMedia
          ? bindings.preparationMedia(input)
          : ({ status: 'blocked', code: 'preparation_media_unavailable' } as const),
      'preparation_media_unavailable',
    );
  return createMicroduckOwnerAdapter({
    owner,
    credentialBoundary,
    approvalResolver,
    proposalResolver,
    versionReview,
    preparationReview,
    preparationMedia,
    explorationReview: async (input) => {
      const read = registration.snapshot()?.explorationReview;
      return read ? read(input) : unavailableExploration(input, 'owner_exploration_unavailable');
    },
    explorationMedia: async (input) =>
      registration.snapshot()?.explorationMedia?.(input) ?? {
        status: 'unavailable',
        reason: '公开归档原件读取器尚未连接。',
      },
  });
}
