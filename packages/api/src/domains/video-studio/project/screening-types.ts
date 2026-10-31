import type { VideoProjectScreening } from '@cat-cafe/shared';
import type { ContentSettlementReceiptV1 } from '../content-owner/types.js';
import type { VideoProjectPrincipal } from './access.js';

export interface RegisterVideoProjectScreeningInput {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly operationId: string;
  readonly id: string;
  readonly title: string;
  readonly input: VideoProjectScreening['input'];
  readonly source: {
    readonly locator: { readonly worktreeId: string; readonly path: string };
    readonly expectedSourceRevision: string;
  };
  readonly mapping: VideoProjectScreening['mapping'];
  readonly refs: readonly string[];
}

/** Only the owner's dedicated append command can consume this validated registration. */
export type AppendVideoProjectScreening = (input: {
  principal: VideoProjectPrincipal;
  contentRef: string;
  expectedOwnerRevision: number;
  operationId: string;
  screening: VideoProjectScreening;
  requestDigest: `sha256:${string}`;
}) => Promise<ContentSettlementReceiptV1>;

export type AuthorizeScreeningCatSource = (input: RegisterVideoProjectScreeningInput) => Promise<void>;

export class VideoProjectScreeningError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'invalid_screening'
      | 'input_changed'
      | 'media_missing'
      | 'media_changed'
      | 'screening_not_found'
      | 'archived',
  ) {
    super(code);
    this.name = 'VideoProjectScreeningError';
  }
}
