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

const oldSha = 'a'.repeat(64),
  newSha = 'b'.repeat(64);
let node: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useChatStore.setState({ currentThreadId: 'review-thread', pendingChatInsert: null });
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
  selection.current = {
    text: 'the selected passage',
    position: { top: 10, left: 10 },
    selectionStart: 1,
    selectionEnd: 21,
  };
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  selection.current = null;
});

const render = async (sha: string) =>
  act(async () =>
    root.render(
      <WorkspaceFileViewer
        file={{
          path: 'notes.md',
          content: sha === oldSha ? 'the selected passage\nold context' : 'new context\nthe selected passage',
          sha256: sha,
          size: 50,
          mime: 'text/markdown',
          truncated: false,
        }}
        openFilePath="notes.md"
        openTabs={['notes.md']}
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
        worktreeId="wt"
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
      />,
    ),
  );

it('an editor opened for a selection of the old file never signs that snapshot with a later file revision', async () => {
  await render(oldSha);
  await act(async () =>
    node.querySelector<HTMLButtonElement>('[data-testid="workspace-markdown-selection-add-to-chat"]')?.click(),
  );
  expect(document.querySelector('[data-testid="context-annotation-comment"]')).not.toBeNull();
  // Browser focus clears the live selection; the real LiveSelectionAnnotationAction keeps its editor snapshot.
  selection.current = null;
  await render(newSha);
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
  if (editor) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, 'revise this old place');
    await act(async () => editor.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
  }
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(
    attachment?.kind === 'quote' && attachment.source.kind === 'workspace_file'
      ? attachment.source.revision
      : 'no file quote',
    'the words selected before the refresh say the version they were selected in, not the newly loaded one',
  ).toBe(`sha256:${oldSha}`);
});

it('a selection made after the file was loaded again says the new version', async () => {
  await render(oldSha);
  selection.current = null;
  await render(newSha);
  selection.current = {
    text: 'the selected passage',
    position: { top: 10, left: 10 },
    selectionStart: 13,
    selectionEnd: 33,
  };
  await render(newSha);
  await act(async () =>
    node.querySelector<HTMLButtonElement>('[data-testid="workspace-markdown-selection-add-to-chat"]')?.click(),
  );
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
  expect(editor).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, 'revise the new place');
  await act(async () => editor?.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () =>
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(
    attachment?.kind === 'quote' && attachment.source.kind === 'workspace_file'
      ? attachment.source.revision
      : 'no file quote',
  ).toBe(`sha256:${newSha}`);
});

it('a selection still on screen when the file is loaded again keeps the version it was made in', async () => {
  await render(oldSha);
  await render(newSha);
  await act(async () =>
    node.querySelector<HTMLButtonElement>('[data-testid="workspace-markdown-selection-add-to-chat"]')?.click(),
  );
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
  expect(editor).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, 'revise the old place');
  await act(async () => editor?.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () =>
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(
    attachment?.kind === 'quote' && attachment.source.kind === 'workspace_file'
      ? attachment.source.revision
      : 'no file quote',
  ).toBe(`sha256:${oldSha}`);
});
