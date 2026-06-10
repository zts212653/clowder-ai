import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceLinkComponent } from '@/components/workspace-md-components';

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

  function clickRelativeLink(worktreeId?: string) {
    // Components['a'] is typed `ComponentType | keyof IntrinsicElements | undefined`; narrow to the
    // function component we know it is so JSX accepts it.
    const Link = createWorkspaceLinkComponent('docs/sub', (c) => c, worktreeId) as React.FC<{
      href?: string;
      children?: React.ReactNode;
    }>;
    act(() => {
      root.render(<Link href="../guide.md">指南</Link>);
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

  it('falls back to null worktree when none provided (docked default — behavior unchanged)', () => {
    clickRelativeLink(undefined);
    expect(setOpenFile).toHaveBeenCalledWith('docs/guide.md', null, null);
  });
});
