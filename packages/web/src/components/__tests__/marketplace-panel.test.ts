import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  apiFetch: vi.fn(),
};

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

import { useMarketplaceStore } from '@/stores/marketplaceStore';
import { MarketplacePanel } from '../marketplace/marketplace-panel';

const MOCK_RESULT = {
  artifactId: 'mcp-memory',
  artifactKind: 'mcp_server' as const,
  displayName: 'MCP Memory',
  ecosystem: 'claude' as const,
  sourceLocator: 'npm:@anthropic/mcp-memory',
  trustLevel: 'verified' as const,
  componentSummary: 'Persistent memory using local knowledge graph',
  transport: 'stdio' as const,
};

describe('MarketplacePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
    useMarketplaceStore.setState({
      results: [MOCK_RESULT],
      selectedResult: null,
      installPlan: null,
      loading: false,
      error: 'Browse failed (400)',
      query: '',
      ecosystemFilter: [],
      trustFilter: [],
      artifactKindsFilter: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders browse results when query is empty', async () => {
    useMarketplaceStore.setState({ results: [MOCK_RESULT], error: null, query: '' });
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [MOCK_RESULT] }) });

    await act(async () => {
      root.render(React.createElement(MarketplacePanel));
    });

    const cards = container.querySelectorAll('[data-testid="artifact-card"]');
    const countText = container.textContent;
    expect(countText).toContain('共 1 个能力');
    expect(cards.length > 0 || countText?.includes('MCP Memory')).toBe(true);
  });

  it('retry in browse mode calls browse instead of no-oping', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [MOCK_RESULT] }) });

    await act(async () => {
      root.render(React.createElement(MarketplacePanel));
    });

    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重试'),
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/marketplace/search?');
    expect(useMarketplaceStore.getState().error).toBeNull();
  });
});
