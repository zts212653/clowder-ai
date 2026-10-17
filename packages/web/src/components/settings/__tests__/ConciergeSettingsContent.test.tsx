// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const showDesktop = vi.hoisted(() => vi.fn());
const openCompanion = vi.hoisted(() => vi.fn());

vi.mock('@/components/concierge/companion-entry', () => ({ openCompanionConversation: openCompanion }));
vi.mock('@/stores/conciergeDesktopStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/conciergeDesktopStore')>()),
  showConciergeDesktop: showDesktop,
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { id: string }) => cat.id,
  useCatData: () => ({
    cats: [{ id: 'fable-5', displayName: '布偶猫', nickname: '宪宪', variantLabel: 'Fable 5' }],
  }),
}));

import { useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ConciergeSettingsContent } from '../ConciergeSettingsContent';

const CONFIG = {
  enabled: false,
  muted: true,
  displayName: '猫猫球',
  personaTone: '温暖',
  dutyCatProfileId: 'fable-5',
  proactivePolicy: 'quiet-badge' as const,
  skin: 'xianxian-codex' as const,
  ballPosition: { x: 83, y: 127 },
  ballSize: 72,
  behaviorEnabled: true,
};

describe('ConciergeSettingsContent behavior controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useConciergeStore.setState({ configLoaded: false, configFailed: false, invocationStatus: 'idle' });
    useConciergeDesktopStore.setState({ available: false });
    showDesktop.mockReset().mockResolvedValue(true);
    openCompanion.mockReset().mockResolvedValue(true);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        config: init?.method === 'PUT' ? { ...CONFIG, ...JSON.parse(String(init.body)) } : CONFIG,
      }),
    }));
  });

  it('recalls a hidden desktop from classic Settings without referring to a missing rail icon', async () => {
    useConciergeDesktopStore.setState({ available: true, visible: false });
    await act(async () => {
      root.render(<ConciergeSettingsContent />);
    });
    expect(container.textContent).not.toContain('左侧猫图标');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="concierge-settings-recall"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('唤回桌面猫猫');
    await act(async () => button?.click());
    expect(showDesktop).toHaveBeenCalledOnce();
    expect(openCompanion).not.toHaveBeenCalled();
  });

  it('opens the canonical companion conversation when no desktop is available', async () => {
    await act(async () => root.render(<ConciergeSettingsContent />));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="concierge-settings-recall"]');
    expect(button?.textContent).toBe('打开伴随对话');
    await act(async () => button?.click());
    expect(openCompanion).toHaveBeenCalledOnce();
    expect(showDesktop).not.toHaveBeenCalled();
  });

  it('falls back to companion conversation if recalling the desktop fails', async () => {
    useConciergeDesktopStore.setState({ available: true });
    showDesktop.mockResolvedValue(false);
    await act(async () => root.render(<ConciergeSettingsContent />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="concierge-settings-recall"]')?.click(),
    );
    expect(showDesktop).toHaveBeenCalledOnce();
    expect(openCompanion).toHaveBeenCalledOnce();
  });

  it('mentions the still-mounted rail icon only in v2', async () => {
    writeShellPresentation('v2');
    await act(async () => root.render(<ConciergeSettingsContent />));
    expect(container.textContent).toContain('左侧猫图标');
    expect(container.querySelector('[data-testid="concierge-settings-recall"]')).not.toBeNull();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockApiFetch.mockReset();
    vi.unstubAllGlobals();
  });

  it('exposes desktop behavior and plugin recovery while preserving retired web visibility preferences', async () => {
    await act(async () => {
      root.render(<ConciergeSettingsContent />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).not.toContain('隐藏猫猫球');
    expect(container.textContent).not.toContain('启用猫猫球');
    expect(container.querySelector('a[href="/settings?s=plugins"]')).not.toBeNull();
    expect(container.textContent).not.toContain('静音模式');
    expect(container.textContent).toContain('猫猫自主活动');

    const switches = container.querySelectorAll('button[role="switch"]');
    expect(switches.length).toBe(1);

    await act(async () => {
      (switches[0] as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const put = mockApiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ behaviorEnabled: false });
    expect(useConciergeStore.getState()).toMatchObject({
      enabled: false,
      muted: true,
      ballPosition: { x: 83, y: 127 },
    });
  });

  it('marks Xianxian as the default skin', async () => {
    await act(async () => {
      root.render(<ConciergeSettingsContent />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('宪宪专属皮肤（视频提取）。（默认）');
    expect(container.textContent).not.toContain('砚砚专属皮肤。（默认）');
  });

  it('keeps the companion entry name fixed while leaving the partner and tone configurable', async () => {
    await act(async () => {
      root.render(<ConciergeSettingsContent />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('猫猫球是固定的伴随入口名称');
    expect(container.querySelector('input[value="猫猫球"]')).toBeNull();
    expect(container.textContent).toContain('人设基调');
    expect(container.textContent).toContain('当前陪伴者');
    expect(container.textContent).toContain('宪宪（Fable 5） · fable-5');
  });
});
