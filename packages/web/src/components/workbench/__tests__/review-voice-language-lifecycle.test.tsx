import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as shellCopy from '@/components/shell/shell-copy';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { homeCopy } from '@/components/workspace-home/workspace-home.shell-copy';
import { useF307ExperienceWorkbenchStore as store } from '../experience-workbench-store';
import { F307WorkbenchTabs } from '../F307WorkbenchTabs';
import { useWorkspaceDestinationAdmission } from '../use-workspace-destination-admission';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-model';
import { workspaceHomeDestinationToSurface } from '../workspace-home-adapter';

const voice = canonicalLauncherDestination('host', 'voice');
const context = { threadId: 'review-thread', worktreeId: 'wt-review', openFilePath: null, preview: { path: '/' } };
const select = vi.fn((surface: WorkspaceSurfaceDescriptor) =>
  store.getState().dispatch({
    type: 'open-surface',
    surface,
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  }),
);
const noop = () => {};
function Harness() {
  const layout = store((s) => s.layout);
  const admission = useWorkspaceDestinationAdmission({
    context,
    worktreeLoading: false,
    worktreeError: null,
    onSelectSurface: select,
  });
  const props: ComponentProps<typeof F307WorkbenchTabs> = {
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
      <button data-testid="open-voice" onClick={() => admission.onSelectDestination(voice)}>
        open
      </button>
      <F307WorkbenchTabs {...props} />
    </>
  );
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  select.mockClear();
  store.setState({ layout: createInitialWorkbenchState(), focusSurfaceId: null });
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
  store.setState({ layout: createInitialWorkbenchState(), focusSurfaceId: null });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const render = async () => {
  await act(async () => root.render(<Harness />));
};
const open = async () => {
  await act(async () => (host.querySelector('[data-testid="open-voice"]') as HTMLButtonElement).click());
};
const tabText = () => host.querySelector('[role="tab"][data-tool-surface-id]')?.textContent;

it('positive: a first English voice open uses localized words and the original identity', async () => {
  writeShellLanguage('en');
  await render();
  await open();
  expect(tabText()).toBe('Voice & meetings');
  expect(store.getState().layout.surfaces[0].objectRef.id).toBe('host:voice');
  expect(store.getState().layout.surfaces[0].context).toBe(homeCopy.en.rows.voice.description);
});

it('an existing voice tab follows zh to en without reopening or replacing the owner', async () => {
  await render();
  await open();
  expect(tabText()).toBe('语音与会议');
  const id = store.getState().layout.surfaces[0].id;
  await act(async () => writeShellLanguage('en'));
  expect(tabText()).toBe('Voice & meetings');
  expect(store.getState().layout.surfaces[0].id).toBe(id);
  expect(select).toHaveBeenCalledOnce();
});

it('an old Chinese voice descriptor renders in English after restoring the existing layout', async () => {
  const cached = workspaceHomeDestinationToSurface(voice, context)!;
  store.setState({ layout: { ...createInitialWorkbenchState(), surfaces: [cached], activeSurfaceId: cached.id } });
  writeShellLanguage('en');
  await render();
  expect(tabText()).toBe('Voice & meetings');
  expect(select).not.toHaveBeenCalled();
});

it('classic admission does not consume the newly added Home language dictionary', async () => {
  writeShellPresentation('classic');
  writeShellLanguage('en');
  const copy = vi.spyOn(shellCopy, 'useShellCopy');
  await render();
  expect(copy.mock.calls.filter(([namespace]) => namespace === homeCopy)).toHaveLength(0);
});
