import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useArtworkGallery, useArtworkReference } from '@/components/content-review/ArtworkGalleryScope';
import {
  addMediaSelectionToChat,
  addMediaWorkToChat,
  composerAttachments,
  removeMediaSelectionFromChat,
  updateMediaSelectionWordsInChat,
} from '@/components/content-review/media-chat-composer';
import {
  addMediaWork,
  MEDIA_SELECTION_REFUSAL_COPY,
  mediaChatMime,
  mediaChatTarget,
  pendingMediaAttachment,
  sameMediaSource,
} from '@/components/content-review/media-chat-selection';
import { sameMediaContentWithAdvancedReview } from '@/components/content-review/media-work-identity';
import type { PendingChatMark } from '@/components/content-review/ReviewPendingChatMarks';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useComposerContextAttachments } from '@/components/useComposerContextAttachments';
import { useChatStore } from '@/stores/chatStore';
import { useRegisterWorkspaceChatWork } from '../WorkspaceChatWorkScope';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import type { ContentReviewView, ContentReviewWorkflow } from './content-review-contract';
import type { WorkspaceAnnotationTarget } from './useWorkspaceContentReview';
import { workspaceReviewRequestSource } from './workspace-modification-source';

/**
 * 「引用到聊天」 for a circled place on a work: it lands in the one chat composer as a media attachment, naming the
 * version that was reviewed through the same source builder "请猫修改" uses, and writes nothing to the review. A
 * surface that knows the work better (a media round with a Task) hands over its own target through the workflow.
 */
export function useWorkspaceMediaChat({
  view,
  path,
  workflow,
  target,
  draft,
  setDraft,
  setTarget,
  referenceOnOpen = false,
  isWorkVisible = () => false,
}: {
  readonly view: ContentReviewView;
  readonly path: string;
  readonly workflow?: ContentReviewWorkflow;
  readonly target: WorkspaceAnnotationTarget | null;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly setTarget: (target: WorkspaceAnnotationTarget | null) => void;
  readonly referenceOnOpen?: boolean;
  readonly isWorkVisible?: () => boolean;
}) {
  const threadId = useChatStore((state) => state.currentThreadId);
  const visible = useWorkspaceSurfaceVisibility();
  const isV2 = useShellPresentation() === 'v2';
  const gallery = useArtworkGallery();
  const reference = useArtworkReference();
  useComposerContextAttachments(threadId ?? '');
  useChatStore((state) => state.pendingChatInsert);
  const composerDraft = threadId ? composerAttachments(threadId) : [];
  const [notice, setNotice] = useState<{ kind: 'selection' | 'whole'; message: string } | null>(null);
  const source = view.currentSource ?? view.review.source;
  const mime =
    source.kind === 'text' || source.kind === 'video-project' || source.kind === 'collective-artifact'
      ? null
      : source.mime;
  const baseChatMedia =
    workflow && 'chatMedia' in workflow
      ? (workflow.chatMedia ?? null)
      : mime
        ? mediaChatTarget({
            title: path.split('/').at(-1) || path,
            mime,
            source: workspaceReviewRequestSource(view),
          })
        : null;
  const origin = gallery?.items[gallery.index]?.origin;
  const chatMedia = baseChatMedia && origin ? { ...baseChatMedia, gallery: origin } : baseChatMedia;
  const pending = chatMedia ? pendingMediaAttachment(composerDraft, chatMedia) : undefined;
  const [editing, setEditing] = useState<{
    key: string;
    attachmentId: string;
    selectionId: string;
    anchor: ArtifactReviewAnchor;
    words: string;
  } | null>(null);
  const editingKey = JSON.stringify([threadId, chatMedia]);
  const editor =
    editing &&
    editing.key === editingKey &&
    origin &&
    threadId &&
    pending?.id === editing.attachmentId &&
    pending.selections.some((item) => item.id === editing.selectionId)
      ? {
          anchor: editing.anchor,
          selectionId: editing.selectionId,
          imageIndex: origin.index,
          words: editing.words,
          change: (words: string) =>
            updateMediaSelectionWordsInChat(threadId, editing.attachmentId, editing.selectionId, words),
          finish: () => setEditing(null),
          cancel: () => {
            if (removeMediaSelectionFromChat(threadId, editing.attachmentId, editing.selectionId)) setEditing(null);
            else setNotice({ kind: 'selection', message: MEDIA_SELECTION_REFUSAL_COPY.recall_pending });
          },
        }
      : null;
  const referenced =
    reference &&
    chatMedia &&
    (sameMediaSource(reference.attachment, chatMedia) ||
      sameMediaContentWithAdvancedReview(reference.attachment, chatMedia))
      ? reference.attachment
      : undefined;
  const marked = pending ?? referenced;
  const marks: readonly PendingChatMark[] | undefined =
    marked && chatMedia && (sameMediaSource(marked, chatMedia) || sameMediaContentWithAdvancedReview(marked, chatMedia))
      ? marked.selections.map((item) => ({
          id: item.id,
          anchor: item.selection,
          ...(marked.gallery ? { label: item.id } : {}),
          active: !!referenced && reference?.selectionId === item.id,
        }))
      : undefined;
  const addSelection = (anchor: ArtifactReviewAnchor) => {
    if (!chatMedia) {
      setNotice({
        kind: 'selection',
        message: MEDIA_SELECTION_REFUSAL_COPY[mime && !mediaChatMime(mime) ? 'not_image' : 'invalid'],
      });
      return false;
    }
    const result = addMediaSelectionToChat(threadId ?? null, chatMedia, anchor, draft, referenceOnOpen && !isV2);
    if (result.kind === 'refused') {
      setNotice({ kind: 'selection', message: MEDIA_SELECTION_REFUSAL_COPY[result.reason] });
      return false;
    }
    setNotice(null);
    if (isV2 && origin)
      setEditing({
        key: editingKey,
        attachmentId: result.attachment.id,
        selectionId: result.selectionId,
        anchor,
        words: result.attachment.selections.find((item) => item.id === result.selectionId)?.instruction ?? '',
      });
    setDraft('');
    setTarget(null);
    return true;
  };
  const add = () => {
    if (target?.kind === 'media_anchor') addSelection(target.anchor);
  };
  const addWork = () => {
    if (!chatMedia) return;
    const result = addMediaWorkToChat(threadId ?? null, chatMedia, referenceOnOpen);
    setNotice(
      result.kind === 'refused' ? { kind: 'whole', message: MEDIA_SELECTION_REFUSAL_COPY[result.reason] } : null,
    );
  };
  const addWorkRef = useRef(addWork);
  addWorkRef.current = addWork;
  const referenceKey = JSON.stringify(chatMedia);
  const mayReference =
    visible &&
    referenceOnOpen &&
    !workflow?.videoWork &&
    !!chatMedia &&
    view.canWrite &&
    view.sourceState === 'current';
  const whole = chatMedia && addMediaWork([], chatMedia);
  useRegisterWorkspaceChatWork(
    threadId ?? null,
    isV2 &&
      visible &&
      referenceOnOpen &&
      view.sourceState === 'current' &&
      !workflow?.mediaSource?.error &&
      whole?.kind === 'added'
      ? whole.attachment
      : null,
    isWorkVisible,
  );
  useEffect(() => {
    // Legacy classic images retain open-time reference behavior. Video Works wait for an explicit mark;
    // v2 reads the visible work only at explicit send.
    if (!isV2 && mayReference) addWorkRef.current();
  }, [isV2, mayReference, referenceKey, threadId]);
  return {
    target: chatMedia,
    offered: target?.kind === 'media_anchor',
    wholeWorkOffered:
      !!mime &&
      !!mediaChatMime(mime) &&
      !!chatMedia &&
      (isV2 || workflow?.videoWork || view.canWrite) &&
      view.sourceState === 'current',
    add,
    addSelection,
    addWork,
    notice: notice && (notice.kind === 'whole' || target?.kind === 'media_anchor') ? notice.message : null,
    clearNotice: () => setNotice(null),
    marks,
    editor,
  };
}
