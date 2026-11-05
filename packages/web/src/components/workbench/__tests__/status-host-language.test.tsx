import { act, type ComponentProps, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { useF307ExperienceWorkbenchStore as store } from '../experience-workbench-store';
import { F307SurfacePane } from '../F307SurfacePane';
import { F307WorkbenchTabs } from '../F307WorkbenchTabs';
import { createInitialWorkbenchState } from '../workbench-model';
import { workbenchTabLabels } from '../workbench-tab-labels';
import { workspaceHomeDestinationToSurface } from '../workspace-home-adapter';

const surface = workspaceHomeDestinationToSurface(canonicalLauncherDestination('host', 'status'), {
  threadId: 'status-language',
  worktreeId: null,
  openFilePath: null,
  preview: { path: '/' },
})!;
let root: Root,
  host: HTMLDivElement,
  mounts = 0;
function Owner() {
  useEffect(() => {
    mounts++;
  }, []);
  return <input aria-label="Source draft" defaultValue="用户原稿" />;
}
const noop = () => {};
function Harness() {
  const layout = store((s) => s.layout);
  const tabs: ComponentProps<typeof F307WorkbenchTabs> = {
    layout,
    dispatch: store.getState().dispatch,
    onAddSurface: noop,
    onActivateSurface: noop,
    homeFocused: false,
    isDesktop: true,
    artifactWorkHostAvailable: false,
    mainAreaAttentionSurfaceId: null,
    onEnterMainAreaAttention: noop,
    onExitMainAreaAttention: noop,
  };
  return (
    <>
      <F307WorkbenchTabs {...tabs} />
      <F307SurfacePane surface={surface}>
        <Owner />
      </F307SurfacePane>
    </>
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  mounts = 0;
  store.setState({
    layout: { ...createInitialWorkbenchState(), surfaces: [surface], activeSurfaceId: surface.id },
    focusSurfaceId: null,
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 320, 32),
  ] as unknown as DOMRectList);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});
it('localizes the restored status tab and pane together without changing the descriptor, owner or draft', async () => {
  const original = JSON.stringify(surface);
  await act(async () => root.render(<Harness />));
  const input = host.querySelector('input');
  const title = () => host.querySelector('[role="tab"][data-tool-surface-id]')?.textContent;
  expect(title()).toBe('状态与会话');
  await act(async () => writeShellLanguage('en'));
  expect(title()).toBe('Status & sessions');
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Status & sessions');
  expect(host.querySelector('input')).toBe(input);
  expect(input?.value).toBe('用户原稿');
  expect(mounts).toBe(1);
  expect(JSON.stringify(surface)).toBe(original);
  expect(store.getState().layout.activeSurfaceId).toBe(surface.id);
  await act(async () => writeShellLanguage('zh'));
  expect(title()).toBe('状态与会话');
  expect(mounts).toBe(1);
});
it('keeps classic, arbitrary stored titles and invalid owner targets unchanged', async () => {
  writeShellPresentation('classic');
  writeShellLanguage('en');
  await act(async () => root.render(<Harness />));
  expect(host.querySelector('article')?.getAttribute('aria-label')).toBe(surface.title);
  const invalid = { ...surface, resultTargetRef: { owner: 'another-owner', key: 'invalid' } };
  expect(workbenchTabLabels([invalid], undefined, undefined, 'Status & sessions').get(invalid.id)).toBe(invalid.title);
});
