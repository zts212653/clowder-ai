import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
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

describe('ChatContainerHeader safe-area', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('applies top safe-area class so iOS standalone status bar does not overlap header', async () => {
    container.innerHTML = renderToStaticMarkup(
      React.createElement(ChatContainerHeader, {
        sidebarOpen: false,
        onToggleSidebar: vi.fn(),
        threadId: 'default',
        authPendingCount: 0,
        viewMode: 'single',
        onToggleViewMode: vi.fn(),
        onOpenMobileStatus: vi.fn(),
        statusPanelOpen: true,
        onToggleStatusPanel: vi.fn(),
        defaultCatId: 'opus',
      }),
    );

    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('safe-area-top');
    expect(header?.className).not.toContain('py-3');

    const innerRow = header?.querySelector('div');
    expect(innerRow).not.toBeNull();
    expect(innerRow?.className).toContain('py-3');
  });
});
