import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { useDesktopUpdateBindings } from '../useDesktopUpdateBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { ownerConsole, projectOwner } from './owner-console';

let prompt: (value: DesktopUpdatePromptPayload) => void;
let progress: (value: DesktopUpdateProgressPayload | null) => void;
let ownerPrompt: DesktopUpdatePromptPayload | null;
let bridge: DesktopBridge;
const stopPrompt = vi.fn(),
  stopProgress = vi.fn();
const available: DesktopUpdateAvailablePromptPayload = {
  kind: 'available',
  version: '1.3.0',
  currentVersion: '1.2.0',
  platform: 'macos',
  assetName: 'clowder.dmg',
  releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v1.3.0',
  releaseNotes: 'Release',
};
beforeEach(() => {
  vi.clearAllMocks();
  ownerPrompt = available;
  window.history.replaceState({}, '', '/?__clowder_desktop_version=1.2.0');
  bridge = {
    onStatus: () => () => {},
    onUpdatePrompt: (fn) => {
      prompt = fn;
      return stopPrompt;
    },
    onUpdateProgress: (fn) => {
      progress = fn;
      return stopProgress;
    },
    getUpdateSettings: vi.fn(async () => ({ autoCheck: true })),
    setUpdateAutoCheck: vi.fn(async (autoCheck) => ({ autoCheck })),
    updatePromptReady: vi.fn(async () => ownerPrompt),
    checkForUpdates: vi.fn(async () => {}),
    sendUpdatePromptAction: vi.fn(),
  };
  window.desktopBridge = bridge;
});
afterEach(async () => {
  await cleanup();
  delete window.desktopBridge;
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

async function ready() {
  const hook = renderHook(() => useDesktopUpdateBindings());
  await waitFor(() =>
    expect(projectOwner('desktop', hook.result.current, {}, undefined, undefined).desktopSystem?.load).toBe(''),
  );
  return hook;
}

it('has no desktop section or invented state in the browser', async () => {
  delete window.desktopBridge;
  const hook = renderHook(() => useDesktopUpdateBindings());
  expect(projectOwner('desktop', hook.result.current, {}, undefined, undefined)).toEqual({
    desktopAvailable: false,
    desktopUpdateState: null,
    desktopSystem: null,
  });
  expect(bridge.getUpdateSettings).not.toHaveBeenCalled();
  expect(await hook.result.current.action('unrelated', {})).toBe(false);
});

it('projects native settings, prompt and progress into the r133 system model', async () => {
  const hook = await ready();
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem).toMatchObject({
    app: { version: '1.2.0' },
    desktopAuto: true,
    update: { version: '1.3.0', canDownload: true, canInstall: false, sections: { progress: false } },
  });
  await act(() => progress({ phase: 'downloading', version: '1.3.0', assetName: 'clowder.dmg', progress: 0.42 }));
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem?.update).toMatchObject({
    canDownload: false,
    sections: { progress: true },
    progress: [{ percent: 42, value: 42 }],
  });
  await act(() => {
    progress(null);
    prompt({ kind: 'ready-to-install', version: '1.3.0', platform: 'macos', assetName: 'clowder.dmg' });
  });
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem?.update).toMatchObject({
    canInstall: true,
    canDownload: false,
  });
  await act(() =>
    prompt({ kind: 'check-failed', version: '1.2.0', releaseUrl: 'https://github.com/zts212653/clowder-ai/releases' }),
  );
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem?.update.failed).toBe(true);
});

it('awaits manual checks and writes automatic checks through the exact native methods', async () => {
  const hook = await ready();
  let finish!: () => void;
  vi.mocked(bridge.checkForUpdates).mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  let completed = false;
  const checking = hook.result.current.action('desktop:check', {}).then(() => {
    completed = true;
  });
  expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
  expect(completed).toBe(false);
  finish();
  await checking;
  expect(completed).toBe(true);
  await act(() => hook.result.current.action('desktop:autoCheck', { autoCheck: false as unknown as string }));
  expect(bridge.setUpdateAutoCheck).toHaveBeenCalledWith(false);
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem?.desktopAuto).toBe(false);
  await act(() => hook.result.current.action('desktop:autoCheck', { autoCheck: 'true' }));
  expect(bridge.setUpdateAutoCheck).toHaveBeenLastCalledWith(true);
});

it('keeps owner state until the real prompt receipt changes after a native action', async () => {
  const hook = await ready();
  await act(() => hook.result.current.action('desktop:action', { action: 'download', version: 'old-version' }));
  expect(bridge.sendUpdatePromptAction).toHaveBeenLastCalledWith('download', 'old-version');
  expect(projectOwner('desktop', hook.result.current, {}).desktopUpdateState?.prompt).toEqual(available);
  ownerPrompt = null;
  await act(() => hook.result.current.action('desktop:action', { action: 'download', version: '1.3.0' }));
  expect(bridge.sendUpdatePromptAction).toHaveBeenLastCalledWith('download', '1.3.0');
  expect(projectOwner('desktop', hook.result.current, {}).desktopUpdateState?.prompt).toBeNull();
});

it('does not mutate confirmed settings through the theme state and retains them after a rejected write', async () => {
  const hook = await ready();
  const state = projectOwner('desktop', hook.result.current, {}).desktopUpdateState;
  assert(state?.settings);
  state.settings.autoCheck = false;
  vi.mocked(bridge.setUpdateAutoCheck).mockRejectedValue(new Error('native settings refused'));
  await expect(hook.result.current.action('desktop:autoCheck', { autoCheck: 'false' })).rejects.toThrow(
    'native settings refused',
  );
  expect(projectOwner('desktop', hook.result.current, {}).desktopSystem?.desktopAuto).toBe(true);
});

it('passes read errors to the common model boundary and does not invent a current version', async () => {
  const failure = new Error('native settings unavailable');
  vi.mocked(bridge.getUpdateSettings).mockRejectedValue(failure);
  const hook = renderHook(() => useDesktopUpdateBindings());
  await waitFor(() => expect(hook.result.current.data.error).toBe(failure));
  const console = ownerConsole();
  console.dataError = vi.fn();
  console.receiveProjectData({ desktop: hook.result.current.data });
  expect(console.dataError).toHaveBeenCalledWith('desktop', failure);
  await cleanup();
  window.history.replaceState({}, '', '/');
  ownerPrompt = null;
  vi.mocked(bridge.getUpdateSettings).mockResolvedValue({ autoCheck: true });
  const fresh = await ready();
  expect(projectOwner('desktop', fresh.result.current, {}).desktopSystem?.app.version).toBeNull();
});

it('releases the existing native subscriptions on unmount', async () => {
  await ready();
  await cleanup();
  expect(stopPrompt).toHaveBeenCalledOnce();
  expect(stopProgress).toHaveBeenCalledOnce();
});
