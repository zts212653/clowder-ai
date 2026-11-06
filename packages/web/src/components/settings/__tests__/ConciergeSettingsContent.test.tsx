// @vitest-environment jsdom

import { WATCHER_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { id: string }) => cat.id,
  useCatData: () => ({
    cats: [{ id: 'fable-5', displayName: '布偶猫', nickname: '宪宪', variantLabel: 'Fable 5' }],
  }),
}));

import { useConciergeStore } from '@/stores/conciergeStore';
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/watcher/config' && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            config: { ...WATCHER_CONFIG_DEFAULTS, enabled: false },
            quietLabels: [],
            availableLabels: [],
            members: [
              {
                catId: WATCHER_CONFIG_DEFAULTS.memberCatId,
                displayName: '小太阳',
                capability: {
                  supported: true,
                  mechanism: 'native_revert',
                  maxWorkingContextTokens: 30000,
                  toolPolicy: 'watcher',
                },
              },
            ],
            rolloutEnabled: false,
          }),
        };
      }
      if (url !== '/api/concierge/config')
        throw new Error(`Unexpected settings request: ${init?.method ?? 'GET'} ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config: init?.method === 'PUT' ? { ...CONFIG, ...JSON.parse(String(init.body)) } : CONFIG,
        }),
      };
    });
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

    expect(container.querySelector('button[aria-label="守望猫总开关"]')).not.toBeNull();
    const switches = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')).filter(
      (button) => button.closest('section')?.querySelector('h3')?.textContent === '主动性策略',
    );
    expect(switches.length).toBe(1);

    await act(async () => {
      switches[0].click();
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
