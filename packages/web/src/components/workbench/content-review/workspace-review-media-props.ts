import type {
  ArtifactReviewAnchor,
  ArtifactReviewDrawing,
  ImmutableMedia,
  WorkspaceContentAnnotationResolution,
  WorkspaceContentVisualMarkResolution,
} from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import type { ContentReviewAnnotation, ContentReviewVisualMark } from './content-review-contract';
import type { CanvasFocusRequest, DiscussionFocusRequest } from './workspace-review-media-focus';
export interface WorkspaceReviewMediaProps {
  readonly sourceError?: string | null;
  readonly draftKey?: string;
  readonly canMarkup?: boolean;
  readonly selected: ArtifactReviewAnchor | null;
  /** An unsaved comment text is present (e.g. restored on return), so its composer should be showing. */
  readonly restoreComment?: boolean;
  readonly composer: ReactNode;
  readonly onOpenDiscussion: () => void;
  readonly reviewId: string;
  readonly sourceRevision: string;
  readonly src: string | null;
  readonly media: ImmutableMedia;
  readonly annotations: readonly ContentReviewAnnotation[];
  readonly annotationResolutions: readonly WorkspaceContentAnnotationResolution[];
  readonly visualMarks: readonly ContentReviewVisualMark[];
  readonly visualMarkResolutions: readonly WorkspaceContentVisualMarkResolution[];
  readonly activeAnnotationId: string | null;
  readonly canWrite: boolean;
  readonly saveBlocked?: boolean;
  readonly onAnchorSelected: (anchor: ArtifactReviewAnchor) => void;
  readonly onAnnotationActive: (annotationId: string) => void;
  readonly discussionFocusRequest?: DiscussionFocusRequest | null;
  readonly canvasFocusRequest?: CanvasFocusRequest | null;
  /** Dismiss the point-comment popover when an in-place modification form takes focus. */
  readonly modificationOpenRequest?: number;
  readonly onSaveVisualMarks: (marks: readonly ArtifactReviewDrawing[]) => Promise<boolean>;
  readonly onDeleteVisualMark: (markId: string) => Promise<boolean>;
}
