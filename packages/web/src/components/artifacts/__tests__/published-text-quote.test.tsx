import type { MessageQuoteSource, QuoteContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { composerAttachments } from '@/components/composer-queue';
import { positionAnnotationMarkers } from '@/components/context-annotation-markers';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';
import { editWorkspaceFileQuoteInChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { publishedTextQuoteSource } from '../PublishedTextReader';

const selection = vi.hoisted(() => ({
  text: 'Original words.',
  position: { top: 10, left: 10 },
  selectionStart: 3,
  selectionEnd: 18,
}));
vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => selection }));
vi.mock('@/components/workspace/FileContentRenderer', () => ({
  FileContentRenderer: ({
    mdSelectionAction,
    onMdAddToChat,
  }: {
    mdSelectionAction: typeof selection | null;
    onMdAddToChat: (action: typeof selection, comment: string) => boolean | void;
  }) => (
    <button
      type="button"
      data-testid="add-selection"
      onClick={() => mdSelectionAction && onMdAddToChat(mdSelectionAction, 'Keep its tone.')}
    >
      add
    </button>
  ),
}));
const THREAD = 'published-quote-destination';
const DIGEST = 'a'.repeat(64);
const source: MessageQuoteSource = {
  kind: 'message',
  threadId: 'original-thread',
  messageId: 'document-message',
  senderCatId: 'codex61-sol',
  artifactFile: {
    item: { kind: 'rich-file', blockId: 'document-file' },
    url: '/uploads/doc-published.md',
    fileName: 'published.md',
    messageRevision: '41',
    displayDigest: `sha256:${DIGEST}`,
  },
};
let container: HTMLDivElement, root: Root;
const initial = useChatStore.getState();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({
    currentThreadId: THREAD,
    currentProjectPath: '/real/project',
    pendingChatInsert: {
      threadId: THREAD,
      text: 'My unsent words\nsecond line',
      contextAttachments: [{ v: 1, kind: 'thread', id: 'kept-ref', threadId: 'kept', title: 'Kept reference' }],
    },
  });
  syncContextAttachmentDraftToStorage(THREAD, []);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  syncContextAttachmentDraftToStorage(THREAD, []);
  useChatStore.setState(initial, true);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.restoreAllMocks();
});
async function render(sha256 = DIGEST) {
  await act(async () =>
    root.render(
      <WorkspaceFileViewer
        file={{
          path: 'published.md',
          content: '# Published\n\nOriginal words.',
          sha256,
          size: 28,
          mime: 'text/markdown',
          truncated: false,
        }}
        source={{ kind: 'url', url: source.artifactFile!.url }}
        quoteSource={source}
        onBack={() => undefined}
      />,
    ),
  );
}
async function add() {
  await act(async () => (container.querySelector('[data-testid="add-selection"]') as HTMLButtonElement).click());
}

it('the actual reader quotes the original message file into the existing destination draft without a workspace locator', async () => {
  await render();
  await add();
  const attachments = composerAttachments(THREAD);
  expect(attachments[0].id).toBe('kept-ref');
  expect(attachments[1]).toMatchObject({ kind: 'quote', text: selection.text, comment: 'Keep its tone.', source });
  expect(useChatStore.getState().pendingChatInsert?.text).toBe('My unsent words\nsecond line');
  expect(JSON.stringify(attachments[1])).not.toContain('worktreeId');
});
it('a selected display snapshot cannot be relabeled with different loaded bytes', async () => {
  await render('b'.repeat(64));
  await add();
  expect(composerAttachments(THREAD)).toHaveLength(1);
});
it('editing then deleting the pending file quote preserves the original id/source and surrounding composer delta', async () => {
  await render();
  await add();
  const original = composerAttachments(THREAD)[1] as QuoteContextAttachment;
  expect(editWorkspaceFileQuoteInChat(THREAD, original, 'Changed comment.')).toBe(true);
  expect(composerAttachments(THREAD)[1]).toEqual({ ...original, comment: 'Changed comment.' });
  expect(editWorkspaceFileQuoteInChat(THREAD, original, null)).toBe(true);
  expect(composerAttachments(THREAD).map((attachment) => attachment.id)).toEqual(['kept-ref']);
  expect(useChatStore.getState().pendingChatInsert?.text).toBe('My unsent words\nsecond line');
});
it('a file leaf offset never creates a marker on identically worded enclosing message text', () => {
  const root = document.createElement('div');
  root.textContent = selection.text;
  vi.spyOn(document, 'createRange').mockReturnValue({
    setStart: () => undefined,
    setEnd: () => undefined,
    toString: () => selection.text,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 10, right: 80 }),
  } as unknown as Range);
  expect(
    positionAnnotationMarkers(root, [
      {
        number: 1,
        attachment: {
          v: 1,
          id: 'file-leaf',
          kind: 'quote',
          source,
          text: selection.text,
          selectionStart: 0,
          selectionEnd: selection.text.length,
        },
      },
    ]),
  ).toEqual([]);
});
it('only a complete local publication identity can supply file metadata; no consumer index or owner version is invented', () => {
  const artifact = {
    type: 'file' as const,
    name: 'published.md',
    url: source.artifactFile!.url,
    createdAt: 41,
    sourceMessageId: source.messageId,
    publicationItem: source.artifactFile!.item,
    catId: 'codex61-sol',
  };
  expect(publishedTextQuoteSource(artifact, 'original-thread', DIGEST)).toEqual(source);
  expect(
    publishedTextQuoteSource({ ...artifact, publicationItem: undefined }, 'original-thread', DIGEST),
  ).toBeUndefined();
  expect(
    publishedTextQuoteSource({ ...artifact, url: 'https://external.example/text.md' }, 'original-thread', DIGEST),
  ).toBeUndefined();
  expect(publishedTextQuoteSource(artifact, undefined, DIGEST)).toBeUndefined();
});
