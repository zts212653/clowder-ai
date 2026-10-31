import type { ContextAttachment, ProjectScreeningContextAttachment } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { composerAttachments } from '../../composer-queue';
import { projectScreeningComposerConflict } from '../../project-screening-composer-group';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '../../thread-drafts';
import { queueScreeningSelection } from '../video-project/selection';

const digest: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
const mark: ProjectScreeningContextAttachment = {
  v: 1,
  kind: 'project-screening',
  id: 'actual-mark',
  title: 'Frozen movie',
  contentRef: 'project-1',
  screeningId: 'screening-1',
  input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
  media: { contentRef: 'movie-1', ownerRevision: 1, blobDigest: digest },
  selections: [{ id: 'place', mediaRange: { startPts: 0, endPts: 1 }, target: { kind: 'project' } }],
};
const incidental: ContextAttachment[] = [
  { v: 1, kind: 'thread', id: 'prior-thread', threadId: 'earlier-thread', title: 'Existing thread context' },
  { v: 1, kind: 'workspace_file', id: 'prior-file', worktreeId: 'root', path: 'notes.md', revision: digest },
];
beforeEach(() => {
  useChatStore.getState().setPendingChatInsert(null);
  syncContextAttachmentDraftToStorage('thread-1', []);
});
afterEach(() => {
  useChatStore.getState().setPendingChatInsert(null);
  syncContextAttachmentDraftToStorage('thread-1', []);
});

it.each(
  incidental.flatMap((item) => ['durable', 'pending'].map((storage) => ({ item, storage }))),
)('preserves compatible original $storage $item.kind context while queuing a frozen screening mark', ({
  item,
  storage,
}) => {
  if (storage === 'durable') syncContextAttachmentDraftToStorage('thread-1', [item]);
  else
    useChatStore.getState().setPendingChatInsert({
      threadId: 'thread-1',
      text: 'Keep these original words',
      contextAttachments: [item],
    });
  expect(queueScreeningSelection('thread-1', mark)).toMatchObject({ kind: 'queued' });
  expect(composerAttachments('thread-1')).toEqual([item, mark]);
  if (storage === 'durable') expect(getContextAttachmentDraft('thread-1')).toEqual([item]);
  else expect(useChatStore.getState().pendingChatInsert?.text).toBe('Keep these original words');
});
it('accepts reciprocal compatible context at original insertion and send admission', () => {
  expect(projectScreeningComposerConflict([mark, ...incidental])).toBeNull();
  expect(projectScreeningComposerConflict([mark, incidental[0], structuredClone(incidental[0])])).toBeNull();
});
it('keeps durable and pending compatible context together without retargeting frozen marks', () => {
  syncContextAttachmentDraftToStorage('thread-1', [incidental[0]]);
  useChatStore.getState().setPendingChatInsert({
    threadId: 'thread-1',
    text: 'Both original references',
    contextAttachments: [incidental[1]],
  });
  expect(queueScreeningSelection('thread-1', mark)).toMatchObject({ kind: 'queued' });
  expect(composerAttachments('thread-1')).toEqual([...incidental, mark]);
  expect(useChatStore.getState().pendingChatInsert?.text).toBe('Both original references');
  expect(projectScreeningComposerConflict(composerAttachments('thread-1'))).toBeNull();
});
