// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { id: string }) => cat.id,
  useCatData: () => ({ cats: [] }),
}));

import { ConciergeSettingsContent } from '../ConciergeSettingsContent';

const CONFIG = {
  enabled: true,
  muted: false,
  displayName: '猫猫球',
  personaTone: '温暖',
  dutyCatProfileId: '',
  proactivePolicy: 'quiet-badge' as const,
  skin: 'yanyan-codex' as const,
  ballPosition: null,
  ballSize: 72,
  behaviorEnabled: true,
};

describe('ConciergeSettingsContent behavior controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockApiFetch.mockReset();
  });

  it('uses visibility language and exposes autonomous behavior in settings', async () => {
    await act(async () => {
      root.render(<ConciergeSettingsContent />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('隐藏猫猫球');
    expect(container.textContent).not.toContain('静音模式');
    expect(container.textContent).toContain('猫猫自主活动');

    const switches = container.querySelectorAll('button[role="switch"]');
    expect(switches.length).toBe(3);

    await act(async () => {
      (switches[2] as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const put = mockApiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ behaviorEnabled: false });
  });
});
