import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => Promise.reject(new Error('offline'))) }));
vi.mock('../icons/CatCafeLogo', () => ({ CatCafeLogo: () => null }));
vi.mock('../ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('../ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (value: string) => value }));

import { ChatContainerHeader } from '../ChatContainerHeader';

function renderHeader(root: Root, props: Record<string, unknown> = {}) {
  return act(async () => {
    root.render(
      <ChatContainerHeader
        sidebarOpen={false}
        onToggleSidebar={vi.fn()}
        threadId="thread-selection"
        authPendingCount={0}
        viewMode="single"
        onToggleViewMode={vi.fn()}
        statusPanelOpen={false}
        onToggleStatusPanel={vi.fn()}
        {...props}
      />,
    );
  });
}

describe('F294 thread-level selection entry', () => {
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
  });

  it('stays visible without hover so touch users can reach message selection', async () => {
    const onEnterSelection = vi.fn();
    await renderHeader(root, { onEnterSelection });

    const entry = container.querySelector<HTMLButtonElement>('[data-testid="thread-select-messages"]');
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute('aria-label')).toBe('选择消息');
    expect(entry?.className).not.toContain('opacity-0');
    expect(entry?.className).not.toContain('group-hover');
    expect(entry?.className).not.toContain('hidden');
    // 44px minimum touch target.
    expect(entry?.className).toContain('h-11');
    expect(entry?.className).toContain('w-11');

    act(() => entry?.click());
    expect(onEnterSelection).toHaveBeenCalledTimes(1);
  });

  it('disappears while selection mode owns the bottom action bar', async () => {
    await renderHeader(root);

    expect(container.querySelector('[data-testid="thread-select-messages"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-panel-toggle"]')).not.toBeNull();
  });
});
