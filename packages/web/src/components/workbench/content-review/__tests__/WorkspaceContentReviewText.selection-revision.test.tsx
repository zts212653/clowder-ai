import type { ContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const selection = vi.hoisted(() => ({
  current: null as null | {
    text: string;
    position: { top: number; left: number };
    selectionStart: number;
    selectionEnd: number;
  },
}));
vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => selection.current }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('@/components/workspace/useWorkspaceListenMode', () => ({
  useWorkspaceListenMode: () => ({
    active: false,
    cache: { active: false, cachedAnchors: [], error: null, totalSentences: 0 },
    sentences: [],
    activeAnchor: null,
    start: vi.fn(),
    cancelCache: vi.fn(),
    startCache: vi.fn(),
  }),
}));

import { WorkspaceContentReviewText } from '../WorkspaceContentReviewText';

const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;
let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ currentThreadId: 'thread-text', pendingChatInsert: null });
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
  selection.current = {
    text: 'the selected passage',
    position: { top: 10, left: 10 },
    selectionStart: 0,
    selectionEnd: 20,
  };
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  selection.current = null;
});

const render = (revision: string) =>
  act(async () =>
    root.render(
      <WorkspaceContentReviewText
        text="the selected passage and the rest"
        markdown
        onQuoteSelected={vi.fn()}
        locator={{ worktreeId: 'wt', path: 'notes.md' }}
        revision={revision}
      />,
    ),
  );

const editor = () => document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');

async function saveWords(words: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor(), words);
  await act(async () => editor()?.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () =>
    editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
}
const savedRevision = () => {
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0] as
    | ContextAttachment
    | undefined;
  return attachment?.kind === 'quote' && attachment.source.kind === 'workspace_file'
    ? attachment.source.revision
    : 'no file quote';
};

it('a card opened on old words keeps its comment and stamps the old revision after a refresh', async () => {
  await render(OLD);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-text-add-to-chat"]')?.click(),
  );
  expect(editor()).not.toBeNull();
  // Browser focus clears the live selection; the card keeps its own copy of it.
  selection.current = null;
  await render(NEW);
  expect(editor()).not.toBeNull();
  await saveWords('仍然是在说旧版这一句');
  expect(savedRevision()).toBe(OLD);
});

it('saves the revision on screen for words selected and saved under it', async () => {
  await render(NEW);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-text-add-to-chat"]')?.click(),
  );
  await saveWords('留下这一句');
  expect(savedRevision()).toBe(NEW);
});
