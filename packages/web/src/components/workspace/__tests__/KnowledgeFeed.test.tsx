import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe('KnowledgeFeed — Collection selector (AC-D1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const feedData = {
    needsReview: [
      {
        id: 'marker-1',
        content: '[decision] Use SQLite for local storage',
        source: 'opus:thread-42',
        status: 'captured',
        createdAt: '2026-05-19',
      },
    ],
    settled: [],
    rejected: [],
    stats: { decisions: 1, lessons: 0, methods: 0, total: 1 },
  };

  const catalogData = {
    collections: [
      {
        manifest: {
          id: 'project:cat-cafe',
          displayName: 'Clowder AI',
          sensitivity: 'internal',
          status: 'active',
        },
      },
      {
        manifest: {
          id: 'global:methods',
          displayName: 'Global Methods',
          sensitivity: 'public',
          status: 'active',
        },
      },
      {
        manifest: {
          id: 'world:archived',
          displayName: 'Archived World',
          sensitivity: 'private',
          status: 'archived',
        },
      },
    ],
  };

  function setupMocks() {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(feedData),
        });
      }
      if (path === '/api/library/catalog') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(catalogData),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it('renders a collection selector dropdown with active collections only', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    // Wait for data fetching
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const selects = container.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(1);

    const select = selects[0]!;
    const options = select.querySelectorAll('option');

    // Should have default "auto" option + 2 active collections (not archived)
    const optionTexts = Array.from(options).map((o) => o.textContent);
    expect(optionTexts.some((t) => t?.includes('Clowder AI'))).toBe(true);
    expect(optionTexts.some((t) => t?.includes('Global Methods'))).toBe(true);
    expect(optionTexts.some((t) => t?.includes('Archived World'))).toBe(false);
  });

  it('sends targetCollectionId when a collection is selected and approved', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Select a collection
    const select = container.querySelector('select')!;
    expect(select).toBeTruthy();

    await act(async () => {
      select.value = 'project:cat-cafe';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Click approve
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve');
    expect(approveBtn).toBeTruthy();

    // Reset mock to capture the approve call
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/approve') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'approved', markerId: 'marker-1' }),
        });
      }
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...feedData, needsReview: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      approveBtn!.click();
    });

    // Verify the approve call included targetCollectionId
    const approveCall = mockApiFetch.mock.calls.find((c: unknown[]) => c[0] === '/api/knowledge/approve');
    expect(approveCall).toBeTruthy();
    const body = JSON.parse((approveCall![1] as RequestInit).body as string);
    expect(body.targetCollectionId).toBe('project:cat-cafe');
  });

  it('sends no targetCollectionId when default "auto" is selected', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Don't change the select — keep default

    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve');

    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/approve') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'approved', markerId: 'marker-1' }),
        });
      }
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...feedData, needsReview: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      approveBtn!.click();
    });

    const approveCall = mockApiFetch.mock.calls.find((c: unknown[]) => c[0] === '/api/knowledge/approve');
    expect(approveCall).toBeTruthy();
    const body = JSON.parse((approveCall![1] as RequestInit).body as string);
    expect(body.targetCollectionId).toBeUndefined();
  });

  it('handles visibility-widening confirmation', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Select a collection
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'global:methods';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve');

    let approveCallCount = 0;
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/approve') {
        approveCallCount++;
        if (approveCallCount === 1) {
          // First call: visibility-widening blocked
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () =>
              Promise.resolve({
                error: 'visibility-widening requires confirmation',
                detail: 'Promoting from private (world:secret) to public (global:methods) widens visibility.',
              }),
          });
        }
        // Second call: with confirmation
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'approved', markerId: 'marker-1' }),
        });
      }
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(feedData),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      approveBtn!.click();
    });

    // Should have called confirm with the detail message
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy.mock.calls[0]![0]).toContain('widens visibility');

    // Should have retried with confirmVisibilityWidening: true
    expect(approveCallCount).toBe(2);
    const retryCall = mockApiFetch.mock.calls.filter((c: unknown[]) => c[0] === '/api/knowledge/approve')[1];
    const retryBody = JSON.parse((retryCall![1] as RequestInit).body as string);
    expect(retryBody.confirmVisibilityWidening).toBe(true);

    confirmSpy.mockRestore();
  });

  it('shows error when approve fails for private marker without collection (P1-2)', async () => {
    const privateFeedData = {
      ...feedData,
      needsReview: [
        {
          id: 'marker-private',
          content: '[lesson] Private knowledge',
          source: 'opus:thread-1',
          status: 'captured',
          sourceSensitivity: 'private',
          sourceCollectionId: 'world:secret',
          createdAt: '2026-05-19',
        },
      ],
    };

    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(privateFeedData),
        });
      }
      if (path === '/api/library/catalog') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(catalogData),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // For private markers, the "auto" option should be disabled or removed
    const select = container.querySelector('select')!;
    expect(select).toBeTruthy();

    // The default empty value option should be disabled for private sources
    const autoOption = Array.from(select.querySelectorAll('option')).find((o) => o.value === '');
    expect(autoOption?.disabled).toBe(true);
  });

  it('shows inline error when non-visibility-widening 400 is returned (P1-2 error handling)', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve');

    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/approve') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: 'targetCollectionId required for private/restricted source markers',
            }),
        });
      }
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(feedData),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      approveBtn!.click();
    });

    // Should show error text in the card area
    const errorText = container.textContent;
    expect(errorText).toContain('targetCollectionId required');
  });

  it('shows error when visibility-widening retry also fails (P2-1)', async () => {
    setupMocks();
    const { KnowledgeFeed } = await import('../KnowledgeFeed');

    await act(async () => {
      root.render(<KnowledgeFeed />);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'global:methods';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve');
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/knowledge/approve') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: 'visibility-widening requires confirmation',
              detail: 'Widening from private to public.',
            }),
        });
      }
      if (path === '/api/knowledge/feed') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(feedData),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await act(async () => {
      approveBtn!.click();
    });

    // Retry also returned 400 — should show error
    const errorText = container.textContent;
    expect(errorText).toContain('visibility-widening');

    confirmSpy.mockRestore();
  });
});
