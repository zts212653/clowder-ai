import type { ContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

// The rendered Markdown is reduced to the one thing this is about: the viewer's own "add to chat" handler, called
// the way the renderer calls it with the selection it was given. The selection comes from the real hook that stamps
// each selection with the version on screen; only the browser's selection discovery is replaced.
vi.mock('@/hooks/useTextSelectionAction', () => ({
  useTextSelectionAction: () => ({
    text: '暮色里的灯塔',
    position: { top: 10, left: 10 },
    selectionStart: 3,
    selectionEnd: 9,
  }),
}));
vi.mock('../FileContentRenderer', () => ({
  FileContentRenderer: ({
    mdSelectionAction,
    onMdAddToChat,
  }: {
    mdSelectionAction: { text: string } | null;
    onMdAddToChat?: (action: never, comment: string) => void;
  }) => (
    <button
      type="button"
      data-testid="add-selection"
      onClick={() => mdSelectionAction && onMdAddToChat?.(mdSelectionAction as never, '保留')}
    >
      add
    </button>
  ),
}));
vi.mock('../useWorkspaceListenMode', () => ({
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

import { WorkspaceFileViewer } from '../WorkspaceFileViewer';

const DIGEST = '9f'.repeat(32);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ pendingChatInsert: null, currentThreadId: 'thread-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function addSelection(filePath: string, openFilePath: string, onQuoteSelected = vi.fn()) {
  await act(async () => {
    root.render(
      <WorkspaceFileViewer
        file={{ path: filePath, content: '# 灯塔', sha256: DIGEST, size: 8, mime: 'text/markdown', truncated: false }}
        openFilePath={openFilePath}
        openTabs={[openFilePath]}
        canEdit={false}
        editMode={false}
        isMarkdown
        isHtml={false}
        isJsx={false}
        markdownRendered
        htmlPreview={false}
        jsxPreview={false}
        saveError={null}
        scrollToLine={null}
        worktreeId="wt-1"
        setOpenFile={vi.fn()}
        closeTab={vi.fn()}
        onCloseCurrentTab={vi.fn()}
        onToggleEdit={vi.fn()}
        onToggleMarkdownRendered={vi.fn()}
        onToggleHtmlPreview={vi.fn()}
        onToggleJsxPreview={vi.fn()}
        collaborationAvailable={false}
        onOpenCollaboration={vi.fn()}
        onSave={vi.fn()}
        onQuoteSelected={onQuoteSelected}
      />,
    );
  });
  await act(async () => (container.querySelector('[data-testid="add-selection"]') as HTMLButtonElement).click());
  const [attachment] = (useChatStore.getState().pendingChatInsert?.contextAttachments ?? []) as ContextAttachment[];
  return attachment?.kind === 'quote' && attachment.source.kind === 'workspace_file' ? attachment.source : null;
}

it('names the version of the file it is showing when the selection is made in it', async () => {
  const source = await addSelection('docs/a.md', 'docs/a.md');
  expect(source?.path).toBe('docs/a.md');
  expect(source?.revision).toBe(`sha256:${DIGEST}`);
});

it('names no version when the file loaded is not the one the tab names', async () => {
  const source = await addSelection('docs/old.md', 'docs/a.md');
  expect(source?.path).toBe('docs/a.md');
  expect(source).not.toHaveProperty('revision');
});

it('consumes the Markdown live selection only after its original quote enters Chat', async () => {
  const onQuoteSelected = vi.fn();
  const source = await addSelection('docs/a.md', 'docs/a.md', onQuoteSelected);
  expect(source?.revision).toBe(`sha256:${DIGEST}`);
  expect(onQuoteSelected.mock.calls).toEqual([['']]);
});

it('keeps the live selection when the original Chat admission refuses the quote', async () => {
  const onQuoteSelected = vi.fn();
  useChatStore.setState({
    pendingChatInsert: { threadId: 'thread-1', text: '', authoritative: true, serverRevision: 5 },
  });
  expect(await addSelection('docs/a.md', 'docs/a.md', onQuoteSelected)).toBeNull();
  expect(onQuoteSelected).not.toHaveBeenCalled();
});
