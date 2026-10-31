import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { useCallback, useRef, useState } from 'react';
import { parsePublicationTarget } from '@/components/workbench/publication-surface';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { focusModification } from './modification-focus';
import { checked, ModificationHttpError } from './modification-http';
import { modificationReviewBinding } from './modification-review-binding';

const UNREADABLE = [401, 403, 404, 410];
const NOT_A_FILE = '这份修改的原作品不是文件，暂时无法在这里打开。';
const VERSION_MISSING = '这份修改返回的版本暂时找不到，无法打开对照。';
const REVIEW_UNCONFIRMED = '这份修改所属的审阅暂时无法确认，无法打开对照。';
const CONVERSATION_SWITCHED = '对话已切换。回到来源后可以继续打开。';
/** The tab's name: the receipt does not know the work's title. The review surface it resolves to names the work itself. */
const PUBLISHED_WORK_TITLE = '作品';

/**
 * The exact version a returned media candidate is. A request made on a published work or a Task round has no file;
 * its returned version is a round of the original review, found through this version's own coordinates.
 */
function returnedVersion(view: ContentModificationDetailView, candidateRef: string | undefined, reviewId: string) {
  const candidate = candidateRef
    ? view.candidates.find((item) => item.kind === 'media' && item.candidateRef === candidateRef)
    : undefined;
  // Only a version the Workspace can open as a publication counts: nothing is thrown at it for a shape it cannot.
  // The review the request is committed to goes with it: the same version can be a round of a sibling review.
  return candidate?.kind === 'media'
    ? parsePublicationTarget({
        contentRef: candidate.asset.contentRef,
        ownerRevision: candidate.asset.ownerRevision,
        reviewId,
      })
    : null;
}

/**
 * Opens the original of a content-modification request from a chat line. The request is read only when the reader
 * asks (not when the message is merely on screen), what opens is the object the request was made on, and the chat
 * message is remembered as the place to come back to. For a request made on a file that is the file, and with
 * `comparison` it opens on that request's own modification panel — on `candidateRef` when the receipt names one —
 * instead of only the file. For a request made on a published work or a Task round there is no file: with
 * `comparison` it opens the review the request is committed to at the returned version's round.
 */
export function useOpenModificationFile(input: {
  requestId: string;
  messageId: string;
  comparison?: boolean;
  candidateRef?: string;
}) {
  const { requestId, messageId, comparison = false, candidateRef } = input;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  const open = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    // An asynchronous read must not steal focus in a conversation opened in the meantime.
    const hostThreadId = useChatStore.getState().currentThreadId;
    try {
      const view = await checked<ContentModificationDetailView>(
        await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}`, undefined, {
          afterCurrentGet: true,
        }),
      );
      const source = view.record.payload.source;
      const store = useChatStore.getState();
      const navigationOrigin = { kind: 'chat-file-link' as const, threadId: hostThreadId, messageId };
      let opened: boolean;
      let asset: { contentRef: string; ownerRevision: number } | undefined;
      if (source.kind === 'workspace') {
        opened = store.openWorkspacePath(hostThreadId, {
          kind: 'file',
          worktreeId: source.locator.worktreeId,
          path: source.locator.path,
          navigationOrigin,
        });
      } else if ((source.kind === 'publication' || source.kind === 'artifact-review') && comparison) {
        // The returned version is a round of the original review: open the work that version belongs to and the
        // owner resolves it to that round. Nothing is guessed when the receipt names a version this request lacks.
        // A receipt is an entry with a known owner, not the work's generic entry: it opens the review the owner
        // committed the request to. A request that names none (or two) is not opened as if it named the work's own.
        const binding = modificationReviewBinding(view.record);
        if (binding.state !== 'bound') {
          setNotice(REVIEW_UNCONFIRMED);
          return;
        }
        const version = returnedVersion(view, candidateRef, binding.reviewId);
        if (!version) {
          setNotice(VERSION_MISSING);
          return;
        }
        asset = { contentRef: version.contentRef, ownerRevision: version.ownerRevision };
        opened = store.openPublication(
          { kind: 'publication', ...version, title: PUBLISHED_WORK_TITLE, navigationOrigin },
          hostThreadId,
        );
      } else {
        setNotice(NOT_A_FILE);
        return;
      }
      if (!opened) setNotice(CONVERSATION_SWITCHED);
      // Only once the Workspace took the object, and tied to that very navigation (the open request's revision is read
      // synchronously after it was minted): the entry that shows this object under it picks the ask up, now or later.
      else if (comparison)
        focusModification({
          record: view.record,
          ...(candidateRef ? { candidateRef } : {}),
          ...(asset ? { asset } : {}),
          navigation: { threadId: hostThreadId, revision: useChatStore.getState().workspaceOpenRevision },
        });
    } catch (error) {
      setNotice(
        error instanceof ModificationHttpError && UNREADABLE.includes(error.status)
          ? '你已无权打开这份修改，或它已不存在。'
          : '暂时无法打开，请重试。',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [requestId, messageId, comparison, candidateRef]);

  return { open, busy, notice };
}
