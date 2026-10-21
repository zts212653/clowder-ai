import type { ContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import type { ContentReviewView, ContentReviewWorkflow } from '../content-review-contract';
import { useWorkspaceMediaChat } from '../useWorkspaceMediaChat';
import { AddToChatButton, AddToChatNotice } from '../WorkspaceMediaChatControls';
import type { WorkspaceAnnotationTarget } from '../workspace-review-draft';
import { mediaView, videoDiscussionView } from './WorkspaceContentReviewSurface.fixture';

const THREAD = 'thread-hook';
const ANCHOR = { kind: 'image-region', x: 1, y: 2, width: 3, height: 4 } as const;
const SELECTED: WorkspaceAnnotationTarget = { kind: 'media_anchor', anchor: ANCHOR };

let container: HTMLDivElement;
let root: Root;
const setDraft = vi.fn();
const setTarget = vi.fn();

function Probe(props: {
  view: ContentReviewView;
  workflow?: ContentReviewWorkflow;
  target: WorkspaceAnnotationTarget | null;
  /** The words typed for the circled place. */
  draft?: string;
  referenceOnOpen?: boolean;
}) {
  const chat = useWorkspaceMediaChat({ path: 'cover.png', draft: '', setDraft, setTarget, ...props });
  return (
    <>
      <AddToChatButton chat={chat} />
      <AddToChatNotice chat={chat} />
    </>
  );
}

const render = (props: Parameters<typeof Probe>[0]) => act(async () => root.render(<Probe {...props} />));
const button = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-media-add-to-chat"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setDraft.mockReset();
  setTarget.mockReset();
  syncContextAttachmentDraftToStorage(THREAD, []);
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('stops showing why a place could not be added once that place is no longer selected', async () => {
  useChatStore.setState({ currentThreadId: undefined });
  await render({ view: mediaView(), target: SELECTED });
  await act(async () => button()?.click());
  expect(container.textContent).toContain('请先打开一个对话');
  // The person moved on (saved the comment instead, or cleared the selection): the old reason does not linger.
  await render({ view: mediaView(), target: null });
  expect(container.textContent).toBe('');
});

it('says the composer cannot take one more place, and keeps the circle, the words and the stored draft', async () => {
  const quote: ContextAttachment = {
    v: 1,
    id: 'quote-big',
    kind: 'quote',
    text: '<'.repeat(7900),
    source: { kind: 'workspace_file', path: 'a.md' },
  };
  syncContextAttachmentDraftToStorage(THREAD, [quote]);
  await render({ view: mediaView(), target: SELECTED, draft: 'x'.repeat(1000) });
  await act(async () => button()?.click());
  expect(container.textContent).toContain('合起来超出了一条消息能带的上限');
  // Nothing the person did is lost, and nothing was queued that the draft store would throw the whole draft away for.
  expect(setTarget).not.toHaveBeenCalled();
  expect(setDraft).not.toHaveBeenCalled();
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(getContextAttachmentDraft(THREAD)).toEqual([quote]);
});

it('says nothing can be named yet when the surface cannot name this work, instead of guessing one', async () => {
  await render({ view: mediaView(), workflow: { chatMedia: null }, target: SELECTED });
  await act(async () => button()?.click());
  expect(container.textContent).toContain('这处选区暂时无法放进对话');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});

it('uses the work a surface names for itself instead of deriving one from the file view', async () => {
  const named = {
    title: '窄屏设计稿',
    mediaType: 'image/png',
    source: { kind: 'artifact-review', reviewId: 'r-1', round: 2, expectedReviewRevision: 4 },
  } as const;
  await render({ view: mediaView(), workflow: { chatMedia: named }, target: SELECTED });
  await act(async () => button()?.click());
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(attachment).toMatchObject({ kind: 'media', title: '窄屏设计稿', source: named.source });
  expect(setTarget).toHaveBeenCalledWith(null);
  expect(setDraft).toHaveBeenCalledWith('');
});

it('opening a video Work in classic leaves the original composer unchanged', async () => {
  writeShellPresentation('classic');
  await render({ view: videoDiscussionView(), workflow: { videoWork: true }, target: null, referenceOnOpen: true });
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(getContextAttachmentDraft(THREAD)).toEqual([]);
});
