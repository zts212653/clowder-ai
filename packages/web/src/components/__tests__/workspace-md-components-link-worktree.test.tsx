import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContentReviewText } from '@/components/workbench/content-review/WorkspaceContentReviewText';
import { createWorkspaceImageComponent, createWorkspaceLinkComponent } from '@/components/workspace-md-components';

/**
 * F226 云端 P2 — a torn-off float carries its own snapshot `worktreeId`. Relative .md links
 * inside the float must navigate within THAT worktree, not whatever the docked workspace
 * currently shows. createWorkspaceLinkComponent now threads worktreeId into setWorkspaceOpenFile
 * (symmetric with the image resolver). Verified via a real click (the worktree arg lives in the
 * onClick handler, so SSR markup can't assert it).
 */
const setOpenFile = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { setWorkspaceOpenFile: typeof setOpenFile }) => unknown) =>
    selector({ setWorkspaceOpenFile: setOpenFile }),
}));

describe('createWorkspaceLinkComponent worktree-scoped navigation (云端 P2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    (globalThis as { React?: typeof React }).React = undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
  });
  beforeEach(() => {
    setOpenFile.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function clickRelativeLink(worktreeId?: string, href = '../guide.md') {
    // Components['a'] is typed `ComponentType | keyof IntrinsicElements | undefined`; narrow to the
    // function component we know it is so JSX accepts it.
    const Link = createWorkspaceLinkComponent('docs/sub', (c) => c, worktreeId) as React.FC<{
      href?: string;
      children?: React.ReactNode;
    }>;
    act(() => {
      root.render(<Link href={href}>指南</Link>);
    });
    const a = container.querySelector('a') as HTMLAnchorElement;
    act(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('navigates a relative md link within the snapshot worktree', () => {
    clickRelativeLink('wt-feature');
    // resolveRelativePath('docs/sub', '../guide.md') === 'docs/guide.md', scoped to wt-feature
    expect(setOpenFile).toHaveBeenCalledWith('docs/guide.md', null, 'wt-feature');
  });

  it('carries the original document and exact source line when its file owner supplies them', () => {
    const Link = createWorkspaceLinkComponent('docs/sub', (c) => c, 'wt-feature', 'docs/sub/original.md') as React.FC<{
      href: string;
      children: React.ReactNode;
      node: { position: { start: { line: number } } };
    }>;
    act(() =>
      root.render(
        <Link href="../guide.md" node={{ position: { start: { line: 17 } } }}>
          指南
        </Link>,
      ),
    );
    act(() => container.querySelector('a')?.click());
    expect(setOpenFile).toHaveBeenCalledWith('docs/guide.md', null, 'wt-feature', undefined, {
      kind: 'workspace-document',
      worktreeId: 'wt-feature',
      path: 'docs/sub/original.md',
      line: 17,
    });
    expect(container.querySelector('a')?.getAttribute('data-workspace-link-line')).toBe('17');
  });

  it('falls back to null worktree when none provided (docked default — behavior unchanged)', () => {
    clickRelativeLink(undefined);
    expect(setOpenFile).toHaveBeenCalledWith('docs/guide.md', null, null);
  });

  it('decodes Markdown URL escapes once before storing the native path', () => {
    clickRelativeLink('wt-feature', '../My%20Guide.md');
    expect(setOpenFile).toHaveBeenCalledWith('docs/My Guide.md', null, 'wt-feature');

    setOpenFile.mockClear();
    clickRelativeLink('wt-feature', '../literal%2520name.md');
    expect(setOpenFile).toHaveBeenCalledWith('docs/literal%20name.md', null, 'wt-feature');
  });

  it('decodes relative image URLs before serializing the native raw-file path', () => {
    const Image = createWorkspaceImageComponent('docs/sub', 'wt-feature') as React.FC<{
      src?: string;
      alt?: string;
    }>;
    act(() => {
      root.render(<Image src="../My%20Guide.png" alt="guide" />);
    });

    const src = container.querySelector('img')?.getAttribute('src');
    expect(src).toBeTruthy();
    expect(new URL(src!, 'http://localhost').searchParams.get('path')).toBe('docs/My Guide.png');
  });

  it('the common collaboration renderer resolves file-owned images and links, masks metadata, and restores the source link line', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const focused: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: function (this: HTMLElement) {
        focused.push(this);
      },
    });
    try {
      act(() =>
        root.render(
          <WorkspaceContentReviewText
            revision={`sha256:${'a'.repeat(64)}`}
            markdown
            text={'---\ntitle: Private metadata\n---\n\n[指南](../guide.md)\n\n![封面](../cover.png)'}
            locator={{ worktreeId: 'wt-feature', path: 'docs/sub/original.md' }}
            scrollToLine={5}
            onQuoteSelected={() => {}}
          />,
        ),
      );
      expect(container.textContent).not.toContain('Private metadata');
      const sourceUrl = new URL(container.querySelector('img')!.src);
      expect(sourceUrl.searchParams.get('worktreeId')).toBe('wt-feature');
      expect(sourceUrl.searchParams.get('path')).toBe('docs/cover.png');
      expect(focused[0]?.getAttribute('data-workspace-link-line')).toBe('5');
      act(() => container.querySelector('a')?.click());
      expect(setOpenFile.mock.calls.at(-1)?.[4]).toEqual({
        kind: 'workspace-document',
        worktreeId: 'wt-feature',
        path: 'docs/sub/original.md',
        line: 5,
      });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});
