import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as shellCopy from '@/components/shell/shell-copy';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { F307SurfacePane } from '../F307SurfacePane';
import { workspaceChromeCopy } from '../workspace-chrome.shell-copy';
import { workspaceHomeDestinationToSurface } from '../workspace-home-adapter';

const surface = workspaceHomeDestinationToSurface(canonicalLauncherDestination('host', 'voice'), {
  threadId: 'review-thread',
  worktreeId: 'wt-review',
  openFilePath: null,
  preview: { path: '/' },
})!;
let root: Root;
let container: HTMLDivElement;
let mounted = 0;
function Owner() {
  useEffect(() => {
    mounted += 1;
  }, []);
  return <div data-testid="voice-owner">Existing voice owner</div>;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  mounted = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  localStorage.clear();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const render = async () => {
  await act(async () =>
    root.render(
      <F307SurfacePane surface={surface}>
        <Owner />
      </F307SurfacePane>,
    ),
  );
};

it('positive: v2 leaves the original workspace owner mounted and hides duplicate host headers', async () => {
  await render();
  expect(surface.type).toBe('workspace');
  expect(container.querySelector('[data-testid="f307-surface-chrome"]')).toBeNull();
  expect(container.querySelector('[data-testid="voice-owner"]')).not.toBeNull();
  const owner = container.querySelector('[data-testid="voice-owner"]');
  await act(async () => writeShellLanguage('en'));
  expect(container.querySelector('[data-testid="voice-owner"]')).toBe(owner);
  expect(mounted).toBe(1);
});

it('the voice pane accessible name follows zh to en for an already restored descriptor', async () => {
  await render();
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('语音与会议');
  await act(async () => writeShellLanguage('en'));
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Voice & meetings');
});

it('positive: classic keeps its stored header and adds no shell language consumer', async () => {
  writeShellPresentation('classic');
  writeShellLanguage('en');
  const copy = vi.spyOn(shellCopy, 'useShellCopy');
  await render();
  expect(copy.mock.calls.filter(([ns]) => ns === workspaceChromeCopy)).toHaveLength(0);
  expect(container.querySelector('[data-testid="f307-surface-chrome"]')?.textContent).toContain(surface.title);
});
