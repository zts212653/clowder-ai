import { type MediaContextAttachment, MediaContextAttachmentSchema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { imageArtworkCopy } from '@/components/content-review/image-artwork.shell-copy';
import { checkShellCopyParity } from '@/components/shell/__tests__/shell-copy-parity-check';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { openFileMenu } from '@/test-utils/open-file-menu';
import { WorkspaceSurfaceVisibilityProvider } from '../../WorkspaceSurfaceVisibility';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, reviewId, revision, view as textView } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

const threadId = 'thread-image-chat-primary';
let container: HTMLDivElement;
let root: Root;

it('keeps the new image actions complete in both shell languages', () => {
  expect(checkShellCopyParity(imageArtworkCopy)).toEqual([]);
});

beforeEach(() => {
  localStorage.clear();
  mocks.apiFetch.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  syncContextAttachmentDraftToStorage(threadId, []);
  useChatStore.setState({ currentThreadId: threadId, pendingChatInsert: null });
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(mediaView()));
    throw new Error(`unexpected write or read: ${url}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function openImage(current = mediaView(), visible = true) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(current));
    throw new Error(`unexpected write or read: ${url}`);
  });
  await act(async () => {
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible={visible}>
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path="cover.png"
          sourceText=""
          sourceTextRevision=""
          onBack={vi.fn()}
        />
      </WorkspaceSurfaceVisibilityProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('does not insert an image reference when a retained hidden owner restores beside the active document', async () => {
  await openImage(mediaView(), false);
  expect(container.querySelector('[data-testid="workspace-review-artwork"]')).not.toBeNull();
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
});

it('opening a visible image leaves the explicit composer and saved attachment draft untouched', async () => {
  writeShellPresentation('v2');
  await openImage();
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
});

it('a readable historical image can be circled for Chat while drawing and saving remain unavailable', async () => {
  writeShellPresentation('v2');
  await openImage({ ...mediaView(), canWrite: false });
  const actions = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="作品操作模式"] button')];
  expect(actions[0]?.disabled).toBe(false);
  expect(actions[1]?.disabled).toBe(true);
  await act(async () => actions[0]?.click());
  expect(actions[0]?.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('textarea')).toBeNull();
  expect(mocks.apiFetch.mock.calls.filter(([url]) => !String(url).includes('/file-info'))).toHaveLength(1);
});

it('keeps an acknowledged removal cleared when the image owner remounts hidden', async () => {
  await openImage();
  const original = useChatStore.getState().pendingChatInsert?.contextAttachments;
  expect(original?.[0].kind).toBe('media');
  await act(async () => {
    syncContextAttachmentDraftToStorage(threadId, []);
    useChatStore.setState({ pendingChatInsert: null });
    root.unmount();
  });
  root = createRoot(container);
  await openImage(mediaView(), false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(getContextAttachmentDraft(threadId)).toEqual([]);
});

it('references the original work once when its hidden surface is explicitly shown', async () => {
  await openImage(mediaView(), false);
  useChatStore.setState({ pendingChatInsert: null });
  await openImage();
  const insert = useChatStore.getState().pendingChatInsert;
  expect(insert?.contextAttachments).toHaveLength(1);
  expect(insert?.contextAttachments?.[0]).toMatchObject({
    kind: 'media',
    source: { kind: 'workspace', locator: { worktreeId: 'worktree-a', path: 'cover.png' } },
    selections: [],
  });
});

it('offers a whole-image Chat action before selecting, preserving the same draft and exact source without sending', async () => {
  await openImage();
  useChatStore.getState().setPendingChatInsert({ threadId, text: '原聊天里还没发出的想法' });
  await openFileMenu(container);
  const action = container.querySelector<HTMLButtonElement>('[data-testid="workspace-media-chat-whole-work"]');
  expect(action, 'opening an image must offer the same Chat path without requiring a selection').not.toBeNull();
  await act(async () => action?.click());
  const draft = useChatStore.getState().pendingChatInsert;
  expect(draft?.text).toBe('原聊天里还没发出的想法');
  const attachment = draft?.contextAttachments?.find((item): item is MediaContextAttachment => item.kind === 'media');
  expect(attachment).toMatchObject({
    title: 'cover.png',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
      expectedReviewRevision: 1,
    },
    selections: [],
  });
  expect(mocks.apiFetch.mock.calls.filter(([url]) => !String(url).includes('/file-info'))).toHaveLength(1);
});

it('does not offer a separate modification sender beside the image Chat path', async () => {
  await openImage();
  expect(container.querySelector('[data-testid="content-modification-entry"]')).toBeNull();
  expect(container.querySelector('[data-testid="workspace-review-artwork"]')).not.toBeNull();
});

it('opens the accepted image tools directly without the old annotation and enlarged-view action row', async () => {
  await openImage();
  const actions = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="作品操作模式"] button')];
  expect(actions.map((button) => button.textContent?.trim())).toEqual(['圈选', '画笔']);
  expect(container.textContent).not.toContain('修改想法 ·');
  expect(container.textContent).not.toContain('放大查看');
  await act(async () => actions[0]?.click());
  expect(container.querySelector('textarea')).toBeNull();
});

it('keeps an original PNG draft readable through records without a second sender or a request write', async () => {
  const words = '之前未发出的原修改意见';
  const key = `cat-cafe:content-modification:operator:${reviewId}`;
  localStorage.setItem(
    key,
    JSON.stringify({
      v: 1,
      sourceVersion: `${reviewId}:${revision}`,
      body: words,
      targetCatId: 'codex-astra',
      threadId: 'old-execution',
      acceptOperations: {},
    }),
  );
  await openImage();
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/content-modifications/context')
      return new Response(JSON.stringify({ requests: [], contexts: [] }));
    if (url === '/api/content-modifications/choices')
      return new Response(
        JSON.stringify({
          cats: [{ catId: 'codex-astra', name: '小星星', mcpSupport: true, restrictions: [] }],
          threads: [{ threadId: 'old-execution', title: '原对话' }],
        }),
      );
    throw new Error(`unexpected write or read: ${url}`);
  });
  const records = container.querySelector<HTMLButtonElement>('[data-testid="content-modification-records"]');
  expect(records).not.toBeNull();
  await act(async () => {
    records?.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  const retained = container.querySelector<HTMLTextAreaElement>('[aria-label="保留的原修改草稿"]');
  expect(retained?.value).toBe(words);
  expect(retained?.readOnly).toBe(true);
  expect(container.querySelector('form[data-testid="content-modification-form"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(key) ?? '{}').body).toBe(words);
  expect(mocks.apiFetch.mock.calls.map(([url]) => url)).not.toContain('/api/content-modifications/requests');
});

it('adding the whole image twice retains one reference with the original attachment id', async () => {
  await openImage();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="workspace-media-chat-whole-work"]');
  await act(async () => button?.click());
  const first = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(first?.kind).toBe('media');
  await act(async () => button?.click());
  expect(useChatStore.getState().pendingChatInsert?.contextAttachments).toEqual([first]);
  expect(mocks.apiFetch.mock.calls.filter(([url]) => !String(url).includes('/file-info'))).toHaveLength(1);
});

it('does not overwrite already circled places when the whole-image action is chosen', async () => {
  await openImage();
  const selection: MediaContextAttachment = {
    v: 1,
    id: 'existing-places',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
      expectedReviewRevision: 1,
    },
    selections: [{ id: '1', selection: { kind: 'image-point', x: 20, y: 30 }, instruction: '保留这处想法' }],
  };
  MediaContextAttachmentSchema.parse(selection);
  await act(async () => syncContextAttachmentDraftToStorage(threadId, [selection]));
  expect(getContextAttachmentDraft(threadId)).toEqual([selection]);
  const before = useChatStore.getState().pendingChatInsert;
  await openFileMenu(container);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="workspace-media-chat-whole-work"]')?.click(),
  );
  expect(useChatStore.getState().pendingChatInsert).toEqual(before);
  expect(container.textContent).toContain('输入框里已有这幅作品的选区');
  expect(mocks.apiFetch.mock.calls.filter(([url]) => !String(url).includes('/file-info'))).toHaveLength(1);
});

it('keeps the existing text request entry and offers no image action for a document', async () => {
  await openImage(textView());
  expect(container.querySelector('[data-testid="workspace-media-chat-whole-work"]')).toBeNull();
  expect(container.querySelector('[data-testid="content-modification-entry"]')).not.toBeNull();
});

it('a read-only image never offers a draft-changing whole-image action', async () => {
  await openImage({ ...mediaView(), canWrite: false });
  expect(container.querySelector('[data-testid="workspace-media-chat-whole-work"]')).toBeNull();
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});
