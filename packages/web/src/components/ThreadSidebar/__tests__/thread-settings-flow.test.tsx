import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) => ({ displayName: catId }),
  }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { threadStates: Record<string, never> }) => unknown) =>
    selector({ threadStates: {} }),
}));
vi.mock('@/stores/label-store', () => ({
  useLabelStore: () => ({ labels: [] }),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://example.test', apiFetch: vi.fn() }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => React.createElement('span', null, 'avatar') }));
vi.mock('@/components/ThreadCatStatus', () => ({ ThreadCatStatus: () => null }));
vi.mock('@/components/icons/HubIcon', () => ({ HubIcon: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));
vi.mock('../thread-utils', () => ({
  formatRelativeTime: () => '1分',
  formatSidebarStatusTime: () => '1分',
}));
vi.mock('../ThreadCatSettings', () => ({
  ThreadCatSettingsContent: () => React.createElement('div', { 'data-testid': 'cats-content' }, 'cats'),
}));
vi.mock('../ThreadEffortSettings', () => ({
  ThreadEffortSettingsContent: () => React.createElement('div', { 'data-testid': 'effort-content' }, 'effort'),
}));
vi.mock('../ThreadSpeedSettings', () => ({
  ThreadSpeedSettingsContent: () => React.createElement('div', { 'data-testid': 'speed-content' }, 'speed'),
}));
vi.mock('../ThreadLabelPicker', () => ({
  ThreadLabelSettingsContent: () => React.createElement('div', { 'data-testid': 'labels-content' }, 'labels'),
}));

import { ThreadItem } from '../ThreadItem';

describe('thread settings end-to-end component flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the thread surface usable through settings detail and back to navigation', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <ThreadItem
          id="thread-1"
          title="Thread 1"
          participants={['codex-sol']}
          lastActiveAt={1}
          isActive={false}
          onSelect={onSelect}
          presence={{ status: 'idle' }}
          unreadCount={0}
          hasUserMention={false}
          onUpdatePreferredCats={vi.fn()}
          onUpdateLabels={vi.fn()}
        />,
      );
    });

    const moreButton = container.querySelector<HTMLButtonElement>('button[title="更多操作"]');
    act(() => moreButton?.click());
    const settingsItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (button) => button.textContent === '对话设置',
    );
    act(() => settingsItem?.click());

    const panel = document.querySelector<HTMLElement>('[data-testid="thread-settings-panel"]');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBe('false');
    expect(panel?.className).toContain('bottom-2');
    expect(panel?.className).toContain('md:right-0');
    expect(panel?.className).toContain('md:w-[400px]');
    expect(document.querySelector('[data-testid$="-content"]')).toBeNull();

    const sectionButton = (label: string) =>
      Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) =>
        button.textContent?.includes(label),
      );
    act(() => sectionButton('默认猫猫')?.click());
    expect(document.querySelector('[data-testid="cats-content"]')).not.toBeNull();
    act(() => sectionButton('思考档位')?.click());
    expect(document.querySelector('[data-testid="cats-content"]')).toBeNull();
    expect(document.querySelector('[data-testid="effort-content"]')).not.toBeNull();

    const title = container.querySelector<HTMLElement>('span[title^="Thread 1"]');
    act(() => {
      title?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      title?.click();
    });

    expect(document.querySelector('[data-testid="thread-settings-panel"]')).toBeNull();
    expect(onSelect).toHaveBeenCalledWith('thread-1');
  });
});
