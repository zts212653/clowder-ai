import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ThreadCatPill', () => ({
  ThreadCatPill: () => null,
}));
vi.mock('@/components/ExportButton', () => ({
  ExportButton: () => null,
}));
vi.mock('@/components/HubButton', () => ({
  HubButton: () => null,
}));
vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));
vi.mock('@/components/VoiceCompanionButton', () => ({
  VoiceCompanionButton: () => null,
}));
vi.mock('@/components/icons/CatCafeLogo', () => ({
  CatCafeLogo: () => React.createElement('span', null, 'logo'),
}));

const mockStore: Record<string, unknown> = {
  threads: [],
  rightPanelMode: 'status',
  setRightPanelMode: vi.fn(),
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

import { ChatContainerHeader } from '@/components/ChatContainerHeader';

describe('ChatContainerHeader Signal navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalLocation: Location;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalLocation = window.location;
    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignSpy },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('navigates to Signal Inbox when header signal button is clicked', () => {
    React.act(() => {
      root.render(
        React.createElement(ChatContainerHeader, {
          sidebarOpen: false,
          onToggleSidebar: vi.fn(),
          threadId: 'thread_abc',
          authPendingCount: 0,
          viewMode: 'single',
          onToggleViewMode: vi.fn(),
          onOpenMobileStatus: vi.fn(),
          statusPanelOpen: false,
          onToggleStatusPanel: vi.fn(),
          defaultCatId: 'opus',
        }),
      );
    });

    const signalButton = container.querySelector('[aria-label="Signal Inbox"]') as HTMLButtonElement | null;
    expect(signalButton).toBeTruthy();

    React.act(() => {
      signalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(assignSpy).toHaveBeenCalledWith('/signals?from=thread_abc');
  });
});
