import type {
  ArtifactReviewActor,
  ArtifactReviewAnchor,
  WorkspaceContentAnnotation,
  WorkspaceContentReview,
  WorkspaceContentReviewAction,
  WorkspaceContentReviewView,
  WorkspaceContentVisualMark,
} from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import type { MediaChatTarget } from '@/components/content-review/media-chat-selection';
import type { WorkspaceAnnotationTarget } from './workspace-review-draft';
import type { LegacyTextNotes } from './workspace-review-legacy-text';

/** Read projections preserve the original actor. This interface creates no ledger or persisted identity. */
export type ContentReviewAnnotation = Omit<WorkspaceContentAnnotation, 'author' | 'replies'> & {
  author: ArtifactReviewActor;
  replies?: Array<
    Omit<NonNullable<WorkspaceContentAnnotation['replies']>[number], 'author'> & { author: ArtifactReviewActor }
  >;
};
export type ContentReviewVisualMark = Omit<WorkspaceContentVisualMark, 'author'> & { author: ArtifactReviewActor };
export type ContentReviewView = Omit<WorkspaceContentReviewView, 'review'> & {
  review: Pick<WorkspaceContentReview, 'reviewId' | 'contentRef' | 'source' | 'revision'> & {
    /** Only private Host projections carry this identity. Public collaboration never impersonates it. */
    ownerUserId?: string;
    annotations: ContentReviewAnnotation[];
    visualMarks?: ContentReviewVisualMark[];
  };
};
export type PrivateContentReviewView = ContentReviewView & { review: { ownerUserId: string } };
export interface ContentReviewController {
  view: ContentReviewView | null;
  error: string | null;
  draft: string;
  target: WorkspaceAnnotationTarget | null;
  activeAnnotationId: string | null;
  busy: boolean;
  pending: boolean;
  setDraft(body: string): void;
  setTarget(target: WorkspaceAnnotationTarget | null): void;
  setActiveAnnotationId(id: string | null): void;
  submitAnnotation(): Promise<void>;
  /** With `expectedSourceRevision`, only moves onto that exact revision; otherwise onto the current one. */
  refreshSource(options?: { readonly expectedSourceRevision?: string }): Promise<void>;
  act(action: WorkspaceContentReviewAction): Promise<boolean>;
  retryPending(): Promise<void>;
  /** Text annotations left by the retired F309 text composer (workspace files only). */
  legacyText?: LegacyTextNotes;
}
export type ContentCapability = { state: 'available' } | { state: 'unavailable' | 'read_only'; reason: string };
export interface ContentLandingCapabilities {
  annotate: ContentCapability;
  reply: ContentCapability;
  markup: ContentCapability;
  requestModification: ContentCapability & { medium: 'image' | 'video' | 'text' | 'project' };
  versions: ContentCapability;
  decide: ContentCapability;
  historyReadOnly: boolean;
}
export interface ContentReviewWorkflow {
  responseDiscussion?: ReactNode;
  videoWork?: boolean;
  playbackHidden?: boolean;
  onPlaybackTime?: (seconds: number) => void;
  chapterNavigation?: ReactNode;
  seekRequest?: { id: number; seconds: number };
  markRequest?: number;
  selectionRequest?: { id: number; anchor: ArtifactReviewAnchor };
  mediaSource?: { src: string | null; downloadSrc?: string | null; error: string | null };
  panel?: ReactNode;
  annotationMaxLength?: number;
  modification?: ReactNode;
  /**
   * The work and version 「引用到聊天」 names, when the surface knows it better than the file view does (a media round
   * with a Task). Null: this surface cannot name one yet. Omitted: the workspace default.
   */
  chatMedia?: MediaChatTarget | null;
  status?: ReactNode;
  canvasDraftKey?: string;
  discussion?: (controls: {
    activeAnnotationId: string | null;
    focusRequest: { annotationId: string; requestId: number } | null;
    onActive(id: string): void;
    onReturnToCanvas(id: string): void;
  }) => ReactNode;
}
