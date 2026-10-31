import type { ContextAttachment, ProjectScreeningContextAttachment } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { addMediaSelection, addMediaWork } from '../../content-review/media-chat-selection';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '../../thread-drafts';
import { queueScreeningSelection } from '../video-project/selection';

const digest = `sha256:${'a'.repeat(64)}`;
const attachment: ProjectScreeningContextAttachment = {
  v: 1,
  kind: 'project-screening',
  id: 'mark-1',
  title: '片子',
  contentRef: 'project-1',
  screeningId: 'frozen-screening',
  input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
  media: { contentRef: 'movie-1', ownerRevision: 1, blobDigest: digest },
  selections: [{ id: 'selection-1', mediaRange: { startPts: 0, endPts: 512 }, target: { kind: 'project' } }],
};
beforeEach(() => {
  useChatStore.getState().setPendingChatInsert(null);
  syncContextAttachmentDraftToStorage('thread-1', []);
});
afterEach(() => syncContextAttachmentDraftToStorage('thread-1', []));
it('keeps a pending insert owned by another thread and refuses to overwrite it with a mark', () => {
  const prior = { threadId: 'other-thread', text: '已经排入的文字' };
  useChatStore.getState().setPendingChatInsert(prior);
  expect(queueScreeningSelection('screening-thread', attachment).kind).toBe('refused');
  expect(useChatStore.getState().pendingChatInsert).toEqual(prior);
});
function mark(id: string, patch: Partial<ProjectScreeningContextAttachment> = {}) {
  return { ...structuredClone(attachment), id, ...patch };
}
const foreign: ContextAttachment[] = [
  mark('screening', { screeningId: 'another-screening' }),
  mark('project', { contentRef: 'another-project' }),
  mark('input-ref', { input: { ...attachment.input, contentRef: 'another-project' } }),
  mark('input-revision', { input: { ...attachment.input, ownerRevision: 2 } }),
  mark('input-digest', { input: { ...attachment.input, blobDigest: `sha256:${'b'.repeat(64)}` } }),
  mark('media-ref', { media: { ...attachment.media, contentRef: 'another-movie' } }),
  mark('media-revision', { media: { ...attachment.media, ownerRevision: 2 } }),
  mark('media-digest', { media: { ...attachment.media, blobDigest: `sha256:${'b'.repeat(64)}` } }),
  {
    v: 1,
    kind: 'quote',
    id: 'quote',
    text: '原引用',
    source: { kind: 'message', threadId: 'thread-1', messageId: 'message' },
  },
  {
    v: 1,
    kind: 'media',
    id: 'ordinary-media',
    title: '图片',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'root', path: 'art.png' },
      expectedSourceRevision: digest,
      reviewId: 'art-review',
      expectedReviewRevision: 1,
    },
    selections: [],
  },
];
it.each(
  foreign.flatMap((item) => ['durable', 'pending'].map((storage) => ({ item, storage }))),
)('preserves $storage $item.id and refuses a mark outside its frozen source group', ({ item, storage }) => {
  if (storage === 'durable') syncContextAttachmentDraftToStorage('thread-1', [item]);
  else
    useChatStore.getState().setPendingChatInsert({ threadId: 'thread-1', text: '原文字', contextAttachments: [item] });
  const queued = structuredClone(useChatStore.getState().pendingChatInsert);
  const draft = [...getContextAttachmentDraft('thread-1')];
  const result = queueScreeningSelection('thread-1', mark('fresh'));
  expect(result).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/发送|移除/) });
  expect(useChatStore.getState().pendingChatInsert).toEqual(queued);
  expect(getContextAttachmentDraft('thread-1')).toEqual(draft);
});
it('keeps multiple independent marks within the same frozen screening, input and movie', () => {
  syncContextAttachmentDraftToStorage('thread-1', [mark('durable')]);
  expect(queueScreeningSelection('thread-1', mark('pending')).kind).toBe('queued');
  expect(queueScreeningSelection('thread-1', mark('fresh', { title: '另一个可读标题' })).kind).toBe('queued');
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.map((item) => item.id)).toEqual([
    'pending',
    'fresh',
  ]);
  expect(getContextAttachmentDraft('thread-1')).toHaveLength(1);
});
it('honors an explicit pending removal when deciding whether a different screening can be queued', () => {
  syncContextAttachmentDraftToStorage('thread-1', [mark('old', { screeningId: 'old-screening' })]);
  useChatStore
    .getState()
    .setPendingChatInsert({ threadId: 'thread-1', text: '移除后再标', removeContextAttachmentIds: ['old'] });
  expect(queueScreeningSelection('thread-1', mark('new')).kind).toBe('queued');
  expect(useChatStore.getState().pendingChatInsert?.removeContextAttachmentIds).toEqual(['old']);
  expect(getContextAttachmentDraft('thread-1')[0]?.id).toBe('old');
});
it('does not duplicate an existing mark ID and make the delivered project source unresolvable', () => {
  syncContextAttachmentDraftToStorage('thread-1', [mark('same')]);
  expect(queueScreeningSelection('thread-1', mark('same')).kind).toBe('refused');
  expect(getContextAttachmentDraft('thread-1')).toHaveLength(1);
});
it('counts the actual takeover selection bound across all same-source attachments', () => {
  const twelve = mark('twelve');
  twelve.selections = Array.from({ length: 12 }, (_, index) => ({ ...attachment.selections[0], id: String(index) }));
  syncContextAttachmentDraftToStorage('thread-1', [twelve]);
  expect(queueScreeningSelection('thread-1', mark('thirteenth')).kind).toBe('refused');
  expect(getContextAttachmentDraft('thread-1')[0]).toEqual(twelve);
});
it('allows the twelfth position across same-source durable and unconsumed pending marks', () => {
  const eleven = mark('eleven');
  eleven.selections = Array.from({ length: 11 }, (_, index) => ({ ...attachment.selections[0], id: String(index) }));
  syncContextAttachmentDraftToStorage('thread-1', [eleven]);
  expect(queueScreeningSelection('thread-1', mark('twelfth')).kind).toBe('queued');
  expect(queueScreeningSelection('thread-1', mark('thirteenth')).kind).toBe('refused');
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments).toHaveLength(1);
});
it('refuses both whole-media and selected-media additions after a project mark', () => {
  const media = foreign.find((item) => item.kind === 'media');
  if (!media) throw new Error('Missing ordinary-media fixture');
  const target = { title: media.title, mediaType: media.mediaType, source: media.source };
  expect(addMediaWork([attachment], target)).toEqual({ kind: 'refused', reason: 'other_source' });
  expect(addMediaSelection([attachment], target, { kind: 'image-point', x: 1, y: 1 })).toEqual({
    kind: 'refused',
    reason: 'other_source',
  });
});
it('preserves the original queued words and frozen screening identity without sending anything', () => {
  useChatStore
    .getState()
    .setPendingChatInsert({ threadId: 'thread-1', text: '这里需要再看', imageUrls: ['/uploads/art.png'] });
  expect(queueScreeningSelection('thread-1', attachment).kind).toBe('queued');
  expect(useChatStore.getState().pendingChatInsert).toMatchObject({
    threadId: 'thread-1',
    text: '这里需要再看',
    imageUrls: ['/uploads/art.png'],
    contextAttachments: [{ ...attachment, screeningId: 'frozen-screening', input: { ownerRevision: 1 } }],
  });
});
