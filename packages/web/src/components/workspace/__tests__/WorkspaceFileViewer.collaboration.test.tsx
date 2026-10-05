import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../FileContentRenderer', () => ({ FileContentRenderer: () => <div data-testid="file-content" /> }));
vi.mock('../useWorkspaceListenMode', () => ({
  useWorkspaceListenMode: () => ({
    active: false,
    cache: null,
    sentences: [],
    activeAnchor: null,
    start: vi.fn(),
    cancelCache: vi.fn(),
    startCache: vi.fn(),
  }),
}));

import { WorkspaceFileViewer } from '../WorkspaceFileViewer';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('does not replace an active editor with collaboration while an unsaved draft may exist', async () => {
  const onOpenCollaboration = vi.fn();
  await act(async () => {
    root.render(
      <WorkspaceFileViewer
        file={{
          path: 'docs/research.md',
          content: '# Draft',
          sha256: 'sha-1',
          size: 7,
          mime: 'text/markdown',
          truncated: false,
        }}
        openFilePath="docs/research.md"
        openTabs={['docs/research.md']}
        canEdit
        editMode
        isMarkdown
        isHtml={false}
        isJsx={false}
        markdownRendered={false}
        htmlPreview={false}
        jsxPreview={false}
        saveError={null}
        scrollToLine={null}
        worktreeId="cat-cafe"
        setOpenFile={vi.fn()}
        closeTab={vi.fn()}
        onCloseCurrentTab={vi.fn()}
        onToggleEdit={vi.fn()}
        onToggleMarkdownRendered={vi.fn()}
        onToggleHtmlPreview={vi.fn()}
        onToggleJsxPreview={vi.fn()}
        collaborationAvailable
        onOpenCollaboration={onOpenCollaboration}
        onSave={vi.fn()}
        revealInFinder={vi.fn()}
      />,
    );
  });
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === '协作批注');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => (button as HTMLButtonElement).click());
  expect(onOpenCollaboration).not.toHaveBeenCalled();
});

it('keeps the way back to the collaborative landing first in the toolbar, before the scrolling tools', async () => {
  // Real page 2026-09-23: in a side-by-side pane the toolbar scrolls horizontally and "协作批注"
  // (the only way back from 文件工具 to the landing) sat at the far end, hidden under the next pane.
  await act(async () => {
    root.render(
      <WorkspaceFileViewer
        file={{
          path: 'desserts.md',
          content: '# 猫咖甜点单',
          sha256: 'sha-1',
          size: 49,
          mime: 'text/markdown',
          truncated: false,
        }}
        openFilePath="desserts.md"
        openTabs={['desserts.md']}
        canEdit
        editMode={false}
        isMarkdown
        isHtml={false}
        isJsx={false}
        markdownRendered={false}
        htmlPreview={false}
        jsxPreview={false}
        saveError={null}
        scrollToLine={null}
        worktreeId="scratch"
        setOpenFile={vi.fn()}
        closeTab={vi.fn()}
        onCloseCurrentTab={vi.fn()}
        onToggleEdit={vi.fn()}
        onToggleMarkdownRendered={vi.fn()}
        onToggleHtmlPreview={vi.fn()}
        onToggleJsxPreview={vi.fn()}
        collaborationAvailable
        onOpenCollaboration={vi.fn()}
        onSave={vi.fn()}
        revealInFinder={vi.fn()}
      />,
    );
  });
  const toolbar = container.querySelector('[data-testid="workspace-file-toolbar"]') as HTMLElement;
  const buttons = [...toolbar.querySelectorAll('button')];
  const back = buttons.find((candidate) => candidate.textContent === '协作批注');
  const viewToggle = buttons.find((candidate) => candidate.textContent === 'Raw');
  expect(back).toBeInstanceOf(HTMLButtonElement);
  expect(viewToggle).toBeInstanceOf(HTMLButtonElement);
  expect(buttons.indexOf(back as HTMLButtonElement)).toBeLessThan(buttons.indexOf(viewToggle as HTMLButtonElement));
});
