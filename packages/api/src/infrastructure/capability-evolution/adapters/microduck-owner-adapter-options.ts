import type {
  EvolutionAssetReviewRequestV1,
  EvolutionAssetReviewV1,
  EvolutionPreparationMediaRequestV1,
  EvolutionPreparationReviewRequestV1,
  EvolutionPreparationReviewV1,
} from '@cat-cafe/shared';
import type { MicroduckExplorationBindings } from './microduck-exploration/publication.js';
import type {
  MicroduckApprovalResolver,
  MicroduckBlocked,
  MicroduckCredentialBoundary,
  MicroduckOwnerPort,
  MicroduckProposalResolver,
} from './microduck-owner-contract.js';
import type { MicroduckPreparationMediaAsset } from './microduck-preparation/football-publication.js';

export interface MicroduckOwnerAdapterOptions extends Partial<MicroduckExplorationBindings> {
  owner: MicroduckOwnerPort;
  credentialBoundary: MicroduckCredentialBoundary;
  approvalResolver: MicroduckApprovalResolver;
  proposalResolver: MicroduckProposalResolver;
  versionReview?: (input: EvolutionAssetReviewRequestV1) => Promise<EvolutionAssetReviewV1>;
  preparationReview?: (input: EvolutionPreparationReviewRequestV1) => Promise<EvolutionPreparationReviewV1>;
  preparationMedia?: (
    input: EvolutionPreparationMediaRequestV1,
  ) => Promise<MicroduckPreparationMediaAsset | MicroduckBlocked>;
  now?: () => string;
}
