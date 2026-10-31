import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopUpdateSettingsPanel } from '../DesktopUpdateSettingsPanel';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('DesktopUpdateSettingsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const getUpdateSettings = vi.fn(async () => ({ autoCheck: true }));
  const setUpdateAutoCheck = vi.fn(async (enabled: boolean) => ({ autoCheck: enabled }));

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getUpdateSettings.mockClear();
    setUpdateAutoCheck.mockClear();
    window.desktopBridge = {
      onStatus: () => () => {},
      onUpdatePrompt: () => () => {},
      onUpdateProgress: () => () => {},
      updatePromptReady: async () => null,
      sendUpdatePromptAction: () => {},
      getUpdateSettings,
      setUpdateAutoCheck,
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete window.desktopBridge;
  });

  it('loads the default-on preference and persists an off choice', async () => {
    await act(async () => {
      root.render(<DesktopUpdateSettingsPanel />);
    });

    expect(getUpdateSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('自动检测更新');
    expect(container.textContent).toContain('每 24 小时');
    const toggle = container.querySelector('[aria-label="自动检测更新"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    await act(async () => toggle.click());

    expect(setUpdateAutoCheck).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders nothing in an ordinary browser', async () => {
    delete window.desktopBridge;

    await act(async () => {
      root.render(<DesktopUpdateSettingsPanel />);
    });

    expect(container.textContent).toBe('');
  });

  it('keeps the previous value and surfaces an IPC failure', async () => {
    setUpdateAutoCheck.mockRejectedValueOnce(new Error('IPC unavailable'));
    await act(async () => {
      root.render(<DesktopUpdateSettingsPanel />);
    });
    const toggle = container.querySelector('[aria-label="自动检测更新"]') as HTMLButtonElement;

    await act(async () => toggle.click());

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('无法保存自动更新设置');
  });
});
