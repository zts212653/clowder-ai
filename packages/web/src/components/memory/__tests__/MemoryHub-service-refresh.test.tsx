import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../workspace/KnowledgeFeed', () => ({ KnowledgeFeed: () => null }));
vi.mock('../CollectionCatalog', () => ({ CollectionCatalog: () => null }));
vi.mock('../CollectionGraph', () => ({ CollectionGraph: () => null }));
vi.mock('../EvidenceSearch', () => ({ EvidenceSearch: () => null }));
vi.mock('../HealthReport', () => ({ HealthReport: () => null }));
vi.mock('../MemoryFlagPanel', () => ({ MemoryFlagPanel: () => null }));
vi.mock('../MemoryNav', () => ({ MemoryNav: () => null }));
vi.mock('../ToolUsageMetricsPanel', () => ({ ToolUsageMetricsPanel: () => null }));
vi.mock('../IndexStatus', () => ({
  IndexStatus: ({ refreshToken }: { refreshToken: number }) => (
    <div data-testid="index-status" data-refresh-token={refreshToken} />
  ),
}));

import { apiFetch } from '@/utils/api-client';
import { MemoryHub } from '../MemoryHub';

const embeddingServicePayload = {
  services: [
    {
      id: 'embedding-model',
      name: 'Embedding Model',
      description: 'Semantic memory embedding endpoint',
      category: 'memory',
      features: ['memory-semantic-search'],
      endpoint: 'http://127.0.0.1:9880',
      configured: true,
      status: 'healthy',
      httpStatus: 200,
      error: null,
      installed: true,
      enabled: true,
      installable: true,
    },
  ],
};

describe('MemoryHub service status refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockFetch = apiFetch as ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('refreshes index status once without refetching services after the parent rerenders', async () => {
    let serviceFetchCount = 0;
    const neverResolves = new Promise(() => undefined);
    mockFetch.mockImplementation((path: string) => {
      if (path !== '/api/services') return Promise.resolve({ ok: true, json: async () => ({}) });
      serviceFetchCount += 1;
      if (serviceFetchCount > 1) return neverResolves;
      return Promise.resolve({ ok: true, json: async () => embeddingServicePayload });
    });

    await act(async () => {
      root.render(<MemoryHub activeTab="status" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="index-status"]')?.getAttribute('data-refresh-token')).toBe('1');
    expect(serviceFetchCount).toBe(1);
  });
});
