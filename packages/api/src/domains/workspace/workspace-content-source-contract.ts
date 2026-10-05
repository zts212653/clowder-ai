import type { Readable } from 'node:stream';
import type { ImmutableMedia } from '@cat-cafe/shared';

export const MAX_WORKSPACE_COLLABORATION_BYTES = 64 * 1024 * 1024;

export interface WorkspaceContentLocatorV1 {
  readonly worktreeId: string;
  readonly path: string;
}

export interface WorkspaceContentPrincipalV1 {
  readonly userId: string;
}

export interface WorkspaceContentDescriptionV1 {
  readonly contentRef: `workspace-content:${string}`;
  readonly revision: `sha256:${string}`;
  readonly locator: WorkspaceContentLocatorV1;
  readonly mime: string;
  readonly byteLength: number;
  readonly kind: 'text' | 'media' | 'unsupported';
}

export interface WorkspaceTextAnchorV1 {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly quoteDigest: `sha256:${string}`;
  readonly contextDigest: `sha256:${string}`;
}

export type WorkspaceTextQuoteResolutionV1 =
  | { readonly status: 'attached'; readonly anchor: WorkspaceTextAnchorV1 }
  | { readonly status: 'ambiguous'; readonly anchor?: undefined }
  | { readonly status: 'orphaned'; readonly anchor?: undefined };

/** Evidence from a persisted raw-source text anchor used for stale-revision remap. */
export interface WorkspaceTextQuoteRemapEvidenceV1 {
  readonly expectedQuoteDigest?: string;
  readonly expectedContextDigest?: string;
}

/** F309 sends persisted anchors to F063; F063 resolves them against one stable current snapshot. */
export interface WorkspaceTextQuoteBatchRequestV1 {
  readonly annotationId: string;
  readonly baseRevision: string;
  readonly quote: string;
  readonly expectedQuoteDigest?: string;
  readonly expectedContextDigest?: string;
}

export type WorkspaceTextQuoteBatchResolutionV1 =
  | { readonly annotationId: string; readonly status: 'attached'; readonly anchor?: WorkspaceTextAnchorV1 }
  | { readonly annotationId: string; readonly status: 'ambiguous'; readonly anchor?: undefined }
  | { readonly annotationId: string; readonly status: 'orphaned'; readonly anchor?: undefined };

export interface WorkspaceTextQuoteBatchResultV1 {
  readonly source: WorkspaceContentDescriptionV1;
  readonly resolutions: readonly WorkspaceTextQuoteBatchResolutionV1[];
}

export class WorkspaceContentSourceError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'not_found'
      | 'revision_changed'
      | 'too_large'
      | 'unsupported_text'
      | 'unsupported_media',
  ) {
    super(code);
    this.name = 'WorkspaceContentSourceError';
  }
}

export interface WorkspaceMediaDescriptionV1 extends WorkspaceContentDescriptionV1 {
  readonly kind: 'media';
  readonly mime: 'image/png' | 'video/mp4';
  readonly media: ImmutableMedia;
}

/** F063 owns the ephemeral immutable snapshot; callers may only relay this one request stream. */
export interface OpenWorkspaceMediaV1 extends WorkspaceMediaDescriptionV1 {
  readonly stream: Readable;
}
