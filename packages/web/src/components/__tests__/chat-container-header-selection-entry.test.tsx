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

describe('F294 message-selection ownership', () => {
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

  it('does not move message selection into the thread header', async () => {
    await renderHeader(root);

    expect(container.querySelector('[data-testid="thread-select-messages"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-panel-toggle"]')).not.toBeNull();
  });

  it('keeps the workspace control without introducing a second selection entry', async () => {
    await renderHeader(root);

    expect(container.querySelector('[data-testid="thread-select-messages"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-panel-toggle"]')).not.toBeNull();
  });
});
